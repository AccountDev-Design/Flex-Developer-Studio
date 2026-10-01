// Identidad: Flex Cloud NO tiene usuarios propios ni login propio. Cada
// peticion se identifica preguntando a Flex Account (introspeccion). La cuenta
// que se usa SIEMPRE sale de esa respuesta, nunca de un campo del cliente.
//
// Dos credenciales, el mismo sistema de identidad:
//   - Web: la sesion de Flex Developer Studio (su cookie), que se reenvia tal
//     cual a Flex Account. Flex Cloud no la interpreta.
//   - Flex OS Ultra (P4): la credencial de dispositivo que FlexOS_Account creo
//     al vincular. Flex Account guardo solo su SHA-256; aqui tambien se
//     pregunta por la huella, la credencial en claro no sale de este proceso.
//
// Contrato completo: docs/FLEX_ACCOUNT_INTEGRATION.md.
import { createHash, randomBytes } from 'node:crypto';
import { E } from '../http/errors.js';

export const sha256hex = (s) => createHash('sha256').update(s).digest('hex');

// Cache pequena con caducidad. Un resultado positivo se reutiliza `cacheMs`;
// si Flex Account deja de responder, uno ya conocido se acepta como mucho
// STALE_MS mas (stale-if-error) para que un corte breve no tumbe la nube.
// Los negativos no se cachean mas de NEG_MS: una cuenta recien vinculada
// tiene que funcionar enseguida.
const STALE_MS = 5 * 60 * 1000;
const NEG_MS = 5 * 1000;
const MAX_ENTRIES = 5000;

class TtlCache {
  constructor() { this.map = new Map(); }
  get(k) { const e = this.map.get(k); if (!e) return null; this.map.delete(k); this.map.set(k, e); return e; }
  set(k, v) {
    this.map.delete(k); this.map.set(k, v);
    while (this.map.size > MAX_ENTRIES) this.map.delete(this.map.keys().next().value);
  }
  delete(k) { this.map.delete(k); }
}

function normalizeIdentity(r) {
  if (!r || typeof r !== 'object') return null;
  if (r.active !== true) {
    const reason = typeof r.reason === 'string' ? r.reason : 'auth_required';
    return { active: false, reason };
  }
  const a = r.account || {};
  if (typeof a.id !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(a.id)) return null;
  return {
    active: true,
    account: {
      id: a.id,
      flexAddress: typeof a.flexAddress === 'string' ? a.flexAddress.slice(0, 64) : null,
      displayName: typeof a.displayName === 'string' ? a.displayName.slice(0, 96) : null,
      plan: typeof a.plan === 'string' ? a.plan : null,
    },
    device: r.device && typeof r.device.id === 'string'
      ? { id: r.device.id.slice(0, 128), label: typeof r.device.label === 'string' ? r.device.label.slice(0, 96) : null }
      : null,
  };
}

export class RemoteAccountGateway {
  constructor({ introspectUrl, serviceKey, cacheMs, timeoutMs }, { fetchImpl = globalThis.fetch, now = Date.now } = {}) {
    this.url = introspectUrl;
    this.key = serviceKey;
    this.cacheMs = cacheMs;
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
    this.now = now;
    this.cache = new TtlCache();
  }

  async #introspect(cacheKey, body) {
    const t = this.now();
    const hit = this.cache.get(cacheKey);
    if (hit && hit.until > t) return hit.value;
    let res;
    try {
      res = await this.fetch(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.key}`, accept: 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: 'error',
      });
    } catch {
      if (hit && hit.value.active && hit.staleUntil > t) return hit.value;
      throw E.accountUnavailable();
    }
    if (!res.ok) {
      if (hit && hit.value.active && hit.staleUntil > t) return hit.value;
      throw E.accountUnavailable();
    }
    let json;
    try { json = await res.json(); } catch { throw E.accountUnavailable(); }
    const value = normalizeIdentity(json);
    if (!value) throw E.accountUnavailable();
    const ttl = value.active ? this.cacheMs : Math.min(this.cacheMs, NEG_MS);
    this.cache.set(cacheKey, { value, until: t + ttl, staleUntil: t + ttl + STALE_MS });
    return value;
  }

  resolveDevice(tokenHash) {
    return this.#introspect(`d:${tokenHash}`, { kind: 'device', tokenHash });
  }

  resolveSession({ cookie, bearer }) {
    if (bearer) return this.#introspect(`b:${sha256hex(bearer)}`, { kind: 'session', bearer });
    if (cookie) return this.#introspect(`c:${sha256hex(cookie)}`, { kind: 'session', cookie });
    return Promise.resolve({ active: false, reason: 'auth_required' });
  }
}

// ---------------------------------------------------------------------------
// MODO DESARROLLO (FLEX_ACCOUNT_MODE=dev). Identidades locales para probar la
// web y el P4 contra un servidor local sin el Flex Account real. config.js
// impide arrancarlo con NODE_ENV=production.
// ---------------------------------------------------------------------------
export const DEV_COOKIE = 'flex_dev_session';

export class DevAccountGateway {
  constructor(db, { now = Date.now } = {}) { this.db = db; this.now = now; }

  createAccount({ flexAddress, displayName, plan = null }) {
    const existing = this.db.get('SELECT id FROM dev_accounts WHERE flex_address = ?', flexAddress);
    if (existing) return existing.id;
    const id = `acc_${randomBytes(9).toString('base64url')}`;
    this.db.run('INSERT INTO dev_accounts (id, flex_address, display_name, plan, created_at) VALUES (?, ?, ?, ?, ?)',
      id, flexAddress, displayName, plan, this.now());
    return id;
  }

  createSession(accountId, ttlMs = 7 * 86400 * 1000) {
    const token = randomBytes(32).toString('base64url');
    this.db.run('INSERT INTO dev_sessions (token_hash, account_id, expires_at) VALUES (?, ?, ?)', sha256hex(token), accountId, this.now() + ttlMs);
    return token;
  }

  // Registra la HUELLA de una credencial de dispositivo (igual que hace
  // Flex Account al aprobar un codigo de vinculacion).
  registerDevice(accountId, tokenHash, label = 'Flex OS Ultra', expiresAt = null) {
    this.db.run('INSERT OR REPLACE INTO dev_devices (token_hash, account_id, label, state, expires_at) VALUES (?, ?, ?, ?, ?)',
      tokenHash, accountId, label, 'active', expiresAt);
  }

  setDeviceState(tokenHash, state) { this.db.run('UPDATE dev_devices SET state = ? WHERE token_hash = ?', state, tokenHash); }

  #identity(accountId, device) {
    const a = this.db.get('SELECT * FROM dev_accounts WHERE id = ?', accountId);
    if (!a) return { active: false, reason: 'auth_required' };
    return { active: true, account: { id: a.id, flexAddress: a.flex_address, displayName: a.display_name, plan: a.plan }, device };
  }

  async resolveDevice(tokenHash) {
    const d = this.db.get('SELECT * FROM dev_devices WHERE token_hash = ?', tokenHash);
    if (!d) return { active: false, reason: 'device_revoked' };
    if (d.state !== 'active') return { active: false, reason: 'device_revoked' };
    if (d.expires_at && d.expires_at < this.now()) return { active: false, reason: 'token_expired' };
    return this.#identity(d.account_id, { id: `dev_${tokenHash.slice(0, 12)}`, label: d.label });
  }

  async resolveSession({ cookie, bearer }) {
    let token = bearer || null;
    if (!token && cookie) {
      for (const part of cookie.split(';')) {
        const [k, ...v] = part.trim().split('=');
        if (k === DEV_COOKIE) token = decodeURIComponent(v.join('='));
      }
    }
    if (!token) return { active: false, reason: 'auth_required' };
    const s = this.db.get('SELECT * FROM dev_sessions WHERE token_hash = ?', sha256hex(token));
    if (!s) return { active: false, reason: 'auth_required' };
    if (s.expires_at < this.now()) return { active: false, reason: 'token_expired' };
    return this.#identity(s.account_id, null);
  }

  destroySession(token) { this.db.run('DELETE FROM dev_sessions WHERE token_hash = ?', sha256hex(token)); }
}
