// Utilidades de prueba: un Flex Cloud real (HTTP de verdad, SQLite y disco)
// en una carpeta temporal, con Flex Account en modo dev y un reloj movible.
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { startCloud } from '../src/server.js';

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

export function clock(start = 1_800_000_000_000) {
  const c = { t: start, now: () => c.t, advance: (ms) => { c.t += ms; } };
  return c;
}

export async function boot({ env = {}, dir, clk, silent = true } = {}) {
  const dataDir = dir || mkdtempSync(join(tmpdir(), 'flex-cloud-test-'));
  const c = clk || clock();
  const cloud = await startCloud({
    env: { FLEX_ACCOUNT_MODE: 'dev', FLEX_CLOUD_DEV_LOGIN: '1', FLEX_CLOUD_PORT: '0', FLEX_CLOUD_JANITOR_MS: '3600000', ...env },
    overrides: { dataDir, secret: 'test-secret-'.padEnd(40, 'x'), clock: c.now, log: silent ? () => {} : undefined },
  });
  const base = `http://127.0.0.1:${cloud.port}`;
  return { cloud, base, dataDir, clk: c, cleanup: async (keep = false) => { await cloud.close(); if (!keep) rmSync(dataDir, { recursive: true, force: true }); } };
}

// Cliente con sesion de navegador (cookie de Flex Account en modo dev).
export async function webClient(base, flexAddress = 'ana@flex', displayName = 'Ana') {
  const r = await fetch(`${base}/api/cloud/dev/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ flexAddress, displayName }) });
  const cookie = r.headers.get('set-cookie').split(';')[0];
  return makeClient(base, { cookie, 'x-flex-cloud': '1' });
}

// Cliente de dispositivo (P4): credencial aleatoria cuya HUELLA se registra.
export async function deviceClient(base, web, label = 'Flex OS Ultra') {
  const token = randomBytes(32).toString('base64url');
  const tokenHash = sha256(token);
  const r = await web.post('/dev/devices', { tokenHash, label });
  if (r.status !== 200) throw new Error('no se pudo registrar el dispositivo');
  const c = makeClient(base, { authorization: `Bearer ${token}` });
  c.token = token; c.tokenHash = tokenHash;
  return c;
}

export function makeClient(base, headers) {
  const api = `${base}/api/cloud`;
  async function call(method, path, body, extra = {}) {
    const h = { ...headers, ...extra };
    let payload;
    if (body !== undefined && !(body instanceof Uint8Array)) { h['content-type'] = 'application/json'; payload = JSON.stringify(body); }
    else payload = body;
    const res = await fetch(api + path, { method, headers: h, body: payload });
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
    return { status: res.status, data, headers: res.headers };
  }
  return {
    headers,
    get: (p, extra) => call('GET', p, undefined, extra),
    post: (p, b, extra) => call('POST', p, b ?? {}, extra),
    patch: (p, b) => call('PATCH', p, b),
    del: (p) => call('DELETE', p),
    put: (p, buf, extra) => call('PUT', p, buf, extra),
    head: (p, extra) => call('HEAD', p, undefined, extra),
    raw: call,
    async putPart(uploadId, n, buf, digest = sha256(buf)) {
      return call('PUT', `/uploads/${uploadId}/parts/${n}`, buf, { 'x-part-sha256': digest, 'content-type': 'application/octet-stream' });
    },
    // Sube un Buffer completo por partes y lo completa.
    async upload(name, buf, { parentId, chunkSize = 64 * 1024, mimeType, withSha = true, clientKey } = {}) {
      const c = await call('POST', '/uploads', { name, size: buf.length, parentId, chunkSize, mimeType, sha256: withSha ? sha256(buf) : undefined, clientKey });
      if (c.status !== 201 && c.status !== 200) return c;
      const u = c.data.upload;
      for (let n = 1; n <= u.totalParts; n++) {
        if (u.receivedParts.includes(n)) continue;
        const part = buf.subarray((n - 1) * u.chunkSize, Math.min(buf.length, n * u.chunkSize));
        const r = await this.putPart(u.uploadId, n, part);
        if (r.status !== 200) return r;
      }
      return call('POST', `/uploads/${u.uploadId}/complete`, {});
    },
  };
}

// PUT de una parte que se CORTA a mitad (Wi-Fi perdido): el servidor no debe
// guardar nada de ella.
export function interruptedPart(base, headers, uploadId, n, buf, cutAt) {
  return new Promise((resolve) => {
    const u = new URL(`${base}/api/cloud/uploads/${uploadId}/parts/${n}`);
    const req = request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'PUT',
      headers: { ...headers, 'x-part-sha256': sha256(buf), 'content-length': buf.length, 'content-type': 'application/octet-stream' } });
    req.on('error', () => resolve('cortado'));
    req.on('response', (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.write(buf.subarray(0, cutAt), () => setTimeout(() => { req.destroy(); resolve('cortado'); }, 30));
  });
}

// Datos deterministas sin reservar el archivo entero.
export function pattern(size, seed = 1) {
  const b = Buffer.allocUnsafe(size);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < size; i += 4) {
    x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
    b.writeUInt32LE(x, i <= size - 4 ? i : size - 4);
  }
  return b;
}
