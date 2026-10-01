// Configuracion de Flex Cloud. TODO sale del entorno: ni cuotas, ni rutas, ni
// secretos estan escritos en el codigo. La cuota gratuita de 5 GB es el valor
// por defecto del plan "free" y se cambia con FLEX_CLOUD_PLANS sin tocar nada.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

export const DEFAULT_PLANS = Object.freeze({
  free: 5 * GiB,
  plus: 10 * GiB,
  pro: 50 * GiB,
  max: 100 * GiB,
});

function intEnv(env, name, def, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = env[name];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    throw new Error(`${name} debe ser un entero entre ${min} y ${max} (recibido: ${raw})`);
  }
  return n;
}

function parsePlans(raw) {
  if (!raw) return { ...DEFAULT_PLANS };
  let obj;
  try { obj = JSON.parse(raw); } catch { throw new Error('FLEX_CLOUD_PLANS no es JSON valido'); }
  const plans = {};
  for (const [name, bytes] of Object.entries(obj)) {
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(name)) throw new Error(`Nombre de plan no valido: ${name}`);
    if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error(`Cuota del plan ${name} no valida`);
    plans[name] = bytes;
  }
  if (!Object.keys(plans).length) throw new Error('FLEX_CLOUD_PLANS no define ningun plan');
  return plans;
}

// El secreto de las URL firmadas. En produccion se exige por entorno; en
// desarrollo se genera una vez y se guarda en la carpeta de datos (0600).
function loadSecret(env, dataDir, production) {
  if (env.FLEX_CLOUD_SECRET) {
    if (env.FLEX_CLOUD_SECRET.length < 32) throw new Error('FLEX_CLOUD_SECRET debe tener al menos 32 caracteres');
    return env.FLEX_CLOUD_SECRET;
  }
  if (production) throw new Error('FLEX_CLOUD_SECRET es obligatorio en produccion');
  const file = join(dataDir, 'secret.key');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  const s = randomBytes(32).toString('base64url');
  writeFileSync(file, s, { mode: 0o600 });
  return s;
}

export function loadConfig(env = process.env, overrides = {}) {
  const production = (env.NODE_ENV || '') === 'production';
  const dataDir = resolve(overrides.dataDir || env.FLEX_CLOUD_DATA_DIR || './data');
  mkdirSync(dataDir, { recursive: true });

  const plans = parsePlans(env.FLEX_CLOUD_PLANS);
  const defaultPlan = env.FLEX_CLOUD_DEFAULT_PLAN || 'free';
  if (!plans[defaultPlan]) throw new Error(`El plan por defecto "${defaultPlan}" no existe en FLEX_CLOUD_PLANS`);

  const accountMode = overrides.accountMode || env.FLEX_ACCOUNT_MODE || (production ? 'remote' : 'dev');
  if (!['remote', 'dev'].includes(accountMode)) throw new Error('FLEX_ACCOUNT_MODE debe ser "remote" o "dev"');
  if (accountMode === 'dev' && production) {
    // El modo dev tiene su propia tabla de cuentas para probar la web sin el
    // servidor real de Flex Account. JAMAS en produccion: seria un segundo
    // sistema de identidad.
    throw new Error('FLEX_ACCOUNT_MODE=dev no esta permitido con NODE_ENV=production');
  }

  const cfg = {
    production,
    host: env.FLEX_CLOUD_HOST || '127.0.0.1',
    port: intEnv(env, 'FLEX_CLOUD_PORT', 8787, { min: 0, max: 65535 }),
    publicUrl: (env.FLEX_CLOUD_PUBLIC_URL || '').replace(/\/+$/, ''),
    dataDir,
    dbFile: join(dataDir, 'flex-cloud.sqlite'),
    objectsDir: join(dataDir, 'objects'),
    uploadsDir: join(dataDir, 'uploads'),
    webDir: resolve(overrides.webDir || env.FLEX_CLOUD_WEB_DIR || new URL('../web', import.meta.url).pathname),
    plans,
    defaultPlan,
    // Tamano de parte por defecto y limites. El cliente puede pedir otro dentro
    // del rango: el P4 usa partes pequenas (256 KB) y la web, grandes.
    chunkDefault: intEnv(env, 'FLEX_CLOUD_CHUNK_BYTES', 8 * MiB, { min: 64 * 1024, max: 64 * MiB }),
    chunkMin: 64 * 1024,
    chunkMax: 64 * MiB,
    maxParts: 10000,
    maxFileBytes: intEnv(env, 'FLEX_CLOUD_MAX_FILE_BYTES', 50 * GiB, { min: 1 }),
    uploadTtlMs: intEnv(env, 'FLEX_CLOUD_UPLOAD_TTL_HOURS', 72, { min: 1, max: 24 * 30 }) * 3600 * 1000,
    trashRetentionMs: intEnv(env, 'FLEX_CLOUD_TRASH_DAYS', 30, { min: 1, max: 3650 }) * 86400 * 1000,
    thumbMaxBytes: 512 * 1024,
    jsonMaxBytes: 64 * 1024,
    signedUrlTtlMs: intEnv(env, 'FLEX_CLOUD_LINK_MINUTES', 15, { min: 1, max: 24 * 60 }) * 60 * 1000,
    janitorIntervalMs: intEnv(env, 'FLEX_CLOUD_JANITOR_MS', 10 * 60 * 1000, { min: 1000 }),
    lowSpaceRatio: 0.9,
    account: {
      mode: accountMode,
      // Contrato: docs/FLEX_ACCOUNT_INTEGRATION.md
      introspectUrl: env.FLEX_ACCOUNT_INTROSPECT_URL || '',
      serviceKey: env.FLEX_ACCOUNT_SERVICE_KEY || '',
      cacheMs: intEnv(env, 'FLEX_ACCOUNT_CACHE_MS', 30 * 1000, { min: 0, max: 10 * 60 * 1000 }),
      timeoutMs: intEnv(env, 'FLEX_ACCOUNT_TIMEOUT_MS', 5000, { min: 500, max: 60000 }),
      devLogin: env.FLEX_CLOUD_DEV_LOGIN === '1' && !production,
    },
    trustProxy: env.FLEX_CLOUD_TRUST_PROXY === '1',
    logLevel: env.FLEX_CLOUD_LOG || (production ? 'info' : 'warn'),
    ...overrides.extra,
  };
  if (cfg.account.mode === 'remote') {
    if (!cfg.account.introspectUrl) throw new Error('FLEX_ACCOUNT_INTROSPECT_URL es obligatorio con FLEX_ACCOUNT_MODE=remote');
    if (production && !cfg.account.introspectUrl.startsWith('https://')) throw new Error('FLEX_ACCOUNT_INTROSPECT_URL debe ser https:// en produccion');
    if (!cfg.account.serviceKey || cfg.account.serviceKey.length < 24) throw new Error('FLEX_ACCOUNT_SERVICE_KEY (>= 24 caracteres) es obligatorio con FLEX_ACCOUNT_MODE=remote');
  }
  cfg.secret = overrides.secret || loadSecret(env, dataDir, production);
  if (overrides.clock) cfg.clock = overrides.clock;
  return cfg;
}
