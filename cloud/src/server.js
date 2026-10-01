// Punto de entrada de Flex Cloud.
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { DevAccountGateway, RemoteAccountGateway } from './account/gateway.js';
import { CloudService } from './cloud/service.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db/database.js';
import { createApp } from './http/app.js';
import { FsObjectStore } from './storage/objectStore.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

// Registro estructurado (una linea JSON). Nunca credenciales ni cookies.
export function makeLogger(level = 'info', sink = (line) => process.stdout.write(line + '\n')) {
  const min = LEVELS[level] ?? 20;
  return (lvl, msg, data) => {
    if ((LEVELS[lvl] ?? 20) < min) return;
    sink(JSON.stringify({ t: new Date().toISOString(), lvl, msg, ...(data || {}) }));
  };
}

export async function startCloud({ env = process.env, overrides = {}, listen = true } = {}) {
  const cfg = loadConfig(env, overrides);
  const log = overrides.log || makeLogger(cfg.logLevel);
  const now = cfg.clock || Date.now;
  const db = openDatabase(cfg.dbFile);
  const store = new FsObjectStore({ objectsDir: cfg.objectsDir, uploadsDir: cfg.uploadsDir });
  await store.init();
  const service = new CloudService({ db, store, cfg, now, log });
  const gateway = overrides.gateway || (cfg.account.mode === 'dev'
    ? new DevAccountGateway(db, { now })
    : new RemoteAccountGateway(cfg.account));
  const rec = await service.recover();
  if (rec.stuck || rec.fixed) log('warn', 'recuperacion al arrancar', rec);

  const handler = createApp({ cfg, service, gateway, log });
  const server = createServer({ requestTimeout: 15 * 60 * 1000, headersTimeout: 60 * 1000, keepAliveTimeout: 65 * 1000 }, handler);

  const janitor = setInterval(async () => {
    try {
      const expired = service.expireUploads();
      const purged = await service.purgeTrash();
      if (expired || purged) log('info', 'mantenimiento', { expiredUploads: expired, purgedFiles: purged });
    } catch (e) { log('error', 'mantenimiento fallo', { err: e.message }); }
  }, cfg.janitorIntervalMs);
  janitor.unref();

  if (listen) {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(cfg.port, cfg.host, resolve); });
    const addr = server.address();
    log('info', 'Flex Cloud escuchando', { host: addr.address, port: addr.port, account: cfg.account.mode });
  }
  return {
    cfg, db, store, service, gateway, server,
    get port() { return server.address()?.port; },
    async close() {
      clearInterval(janitor);
      const closed = new Promise((r) => server.close(() => r()));
      server.closeAllConnections?.();
      await closed;
      db.close();
    },
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  startCloud().catch((e) => { console.error(`Flex Cloud no pudo arrancar: ${e.message}`); process.exit(1); });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));
}
