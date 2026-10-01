// Aplicacion HTTP de Flex Cloud: API (/api/cloud/*) y la web (estaticos).
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { DEV_COOKIE, sha256hex } from '../account/gateway.js';
import { contentDisposition, inlineSafe, ID_RE } from '../cloud/names.js';
import { CloudError, E, errorBody } from './errors.js';
import { Router } from './router.js';
import { RateLimiter, clientIp, parseRange, partDigest, readBuffer, readJson, securityHeaders, sendJson } from './util.js';

const API = '/api/cloud';
const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2',
};
// Scripts SOLO propios (ni en linea ni de terceros). Los estilos en linea si:
// las barras de progreso fijan su anchura con style y no ejecutan nada.
const WEB_CSP = "default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; " +
                "connect-src 'self'; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'";

export function createApp({ cfg, service, gateway, log }) {
  const router = new Router();
  const authFailures = new RateLimiter({ windowMs: 60_000, max: 60 });
  const perAccount = new RateLimiter({ windowMs: 60_000, max: 3000 });

  // ------------------------------------------------------------ identidad
  async function identify(req) {
    const ip = clientIp(req, cfg.trustProxy);
    if (authFailures.blocked(ip)) throw E.rateLimited();
    const auth = req.headers.authorization;
    let identity, kind;
    try {
      if (typeof auth === 'string' && /^Bearer\s+/i.test(auth)) {
        // Credencial de DISPOSITIVO (Flex OS Ultra). Solo viaja su huella.
        const token = auth.replace(/^Bearer\s+/i, '').trim();
        if (!/^[A-Za-z0-9_-]{20,256}$/.test(token)) throw E.authRequired();
        identity = await gateway.resolveDevice(sha256hex(token));
        kind = 'device';
      } else {
        identity = await gateway.resolveSession({ cookie: req.headers.cookie || '' });
        kind = 'session';
      }
    } catch (e) {
      if (e instanceof CloudError && e.status === 401) authFailures.hit(ip);
      throw e;
    }
    if (!identity.active) {
      authFailures.hit(ip);
      if (identity.reason === 'token_expired') throw E.tokenExpired();
      if (identity.reason === 'device_revoked') throw E.deviceRevoked();
      throw E.authRequired();
    }
    const accountId = service.ensureAccount(identity);
    if (!perAccount.hit(accountId)) throw E.rateLimited();
    return { accountId, identity, kind };
  }

  // CSRF: con cookie, una peticion que cambia algo tiene que venir de la
  // propia web (cabecera propia + mismo origen). Con la credencial del
  // dispositivo no aplica: no hay cookie ambiental que un tercero aproveche.
  function checkCsrf(req, who) {
    if (who.kind !== 'session' || req.method === 'GET' || req.method === 'HEAD') return;
    if (req.headers['x-flex-cloud'] !== '1') throw E.csrf();
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin' && site !== 'none') throw E.csrf();
    const origin = req.headers.origin;
    if (origin) {
      let host;
      try { host = new URL(origin).host; } catch { throw E.csrf(); }
      const allowed = new Set([req.headers.host]);
      if (cfg.publicUrl) allowed.add(new URL(cfg.publicUrl).host);
      if (!allowed.has(host)) throw E.csrf();
    }
  }

  const authed = (fn) => async (req, res, ctx) => {
    const who = await identify(req);
    checkCsrf(req, who);
    return fn(req, res, { ...ctx, who, acc: who.accountId });
  };
  const json = (req) => readJson(req, cfg.jsonMaxBytes);
  const ok = (res, obj, status = 200) => sendJson(res, status, { ok: true, ...obj });
  const typeOf = (id) => (ID_RE.folder.test(id) ? 'folder' : 'file');

  // ----------------------------------------------------------------- rutas
  router.add('GET', `${API}/health`, async (req, res) => ok(res, {
    service: 'flex-cloud', version: 1, time: Date.now(),
    // La web lo usa para ofrecer el acceso de desarrollo; en produccion es "remote".
    accountMode: cfg.account.mode, devLogin: cfg.account.mode === 'dev' && cfg.account.devLogin,
  }));

  router.add('GET', `${API}/me`, authed(async (req, res, { who, acc }) => {
    const a = who.identity.account;
    ok(res, {
      account: { id: a.id, flexAddress: a.flexAddress, displayName: a.displayName },
      device: who.identity.device || null,
      quota: service.quota(acc),
      limits: { maxFileBytes: cfg.maxFileBytes, chunkDefault: cfg.chunkDefault, chunkMin: cfg.chunkMin, chunkMax: cfg.chunkMax },
    });
  }));

  router.add('GET', `${API}/quota`, authed(async (req, res, { acc }) => ok(res, { quota: service.quota(acc) })));

  router.add('GET', `${API}/files`, authed(async (req, res, { acc, url }) => {
    const q = Object.fromEntries(url.searchParams);
    ok(res, service.list(acc, q));
  }));

  router.add('GET', `${API}/files/:id`, authed(async (req, res, { acc, params }) => ok(res, { file: service.getFile(acc, params.id) })));

  router.add('PATCH', `${API}/files/:id`, authed(async (req, res, { acc, params }) => {
    const b = await json(req);
    ok(res, { file: service.updateFile(acc, params.id, { name: b.name, parentId: b.parentId }) });
  }));

  router.add('DELETE', `${API}/files/:id`, authed(async (req, res, { acc, params, url }) => {
    if (url.searchParams.get('permanent') === '1') return ok(res, await service.permanentDelete(acc, 'file', params.id));
    service.trash(acc, 'file', params.id);
    ok(res, { trashed: true, quota: service.quota(acc) });
  }));

  router.add('POST', `${API}/files/:id/restore`, authed(async (req, res, { acc, params }) => ok(res, service.restore(acc, 'file', params.id))));
  router.add('POST', `${API}/files/:id/permanent-delete`, authed(async (req, res, { acc, params }) => {
    const r = await service.permanentDelete(acc, 'file', params.id);
    ok(res, { ...r, quota: service.quota(acc) });
  }));

  router.add('PUT', `${API}/files/:id/thumbnail`, authed(async (req, res, { acc, params }) => {
    const mime = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const buf = await readBuffer(req, cfg.thumbMaxBytes);
    ok(res, await service.setThumbnail(acc, params.id, buf, mime));
  }));

  router.add('GET', `${API}/files/:id/thumbnail`, authed(async (req, res, { acc, params }) => {
    const f = service.thumbnail(acc, params.id);
    const etag = `"t-${f.thumb_key}"`;
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    if (req.headers['if-none-match'] === etag) { res.statusCode = 304; res.end(); return; }
    await sendObject(req, res, { key: f.thumb_key, size: f.thumb_size, mime: f.thumb_mime, name: 'miniatura', inline: true, etag });
  }));

  router.add('POST', `${API}/files/:id/link`, authed(async (req, res, { acc, params }) => {
    const { token, expiresAt } = service.signLink(acc, params.id);
    ok(res, { url: `${cfg.publicUrl}${API}/d/${token}`, path: `${API}/d/${token}`, expiresAt });
  }));

  router.add('GET', `${API}/download/:id`, authed(async (req, res, { acc, params, url }) => {
    const f = service.fileForDownload(acc, params.id);
    await sendFile(req, res, f, url.searchParams.get('inline') === '1');
  }));

  // Enlace firmado: la firma ES la autorizacion (no hace falta cookie ni
  // cabecera; sirve para <video src> y para reanudar con Range).
  router.add('GET', `${API}/d/:token`, async (req, res, { params, url }) => {
    const f = service.verifyLink(params.token);
    await sendFile(req, res, f, url.searchParams.get('inline') === '1');
  });

  router.add('POST', `${API}/folders`, authed(async (req, res, { acc }) => {
    const b = await json(req);
    ok(res, { folder: service.createFolder(acc, { name: b.name, parentId: b.parentId, conflict: b.conflict }) }, 201);
  }));
  router.add('GET', `${API}/folders/:id`, authed(async (req, res, { acc, params }) => ok(res, { folder: service.getFolder(acc, params.id) })));
  router.add('PATCH', `${API}/folders/:id`, authed(async (req, res, { acc, params }) => {
    const b = await json(req);
    ok(res, { folder: service.updateFolder(acc, params.id, { name: b.name, parentId: b.parentId }) });
  }));
  router.add('DELETE', `${API}/folders/:id`, authed(async (req, res, { acc, params, url }) => {
    if (url.searchParams.get('permanent') === '1') return ok(res, await service.permanentDelete(acc, 'folder', params.id));
    ok(res, { trashed: true, ...service.trash(acc, 'folder', params.id) });
  }));
  router.add('POST', `${API}/folders/:id/restore`, authed(async (req, res, { acc, params }) => ok(res, service.restore(acc, 'folder', params.id))));
  router.add('POST', `${API}/folders/:id/permanent-delete`, authed(async (req, res, { acc, params }) => {
    const r = await service.permanentDelete(acc, 'folder', params.id);
    ok(res, { ...r, quota: service.quota(acc) });
  }));

  router.add('POST', `${API}/trash/restore`, authed(async (req, res, { acc }) => {
    const b = await json(req);
    if (typeof b.id !== 'string') throw E.invalid('Falta id.');
    ok(res, service.restore(acc, typeOf(b.id), b.id));
  }));
  router.add('POST', `${API}/trash/empty`, authed(async (req, res, { acc }) => {
    const r = await service.emptyTrash(acc);
    ok(res, { ...r, quota: service.quota(acc) });
  }));

  router.add('GET', `${API}/uploads`, authed(async (req, res, { acc }) => ok(res, { uploads: service.listUploads(acc) })));
  router.add('POST', `${API}/uploads`, authed(async (req, res, { acc, who }) => {
    const b = await json(req);
    const u = service.createUpload(acc, b, who.kind === 'device' ? 'device' : 'web');
    ok(res, { upload: u }, u.resumed ? 200 : 201);
  }));
  const status = authed(async (req, res, { acc, params }) => ok(res, { upload: service.uploadStatus(acc, params.id) }));
  router.add('GET', `${API}/uploads/:id`, status);
  router.add('GET', `${API}/uploads/:id/status`, status);
  const part = authed(async (req, res, { acc, params }) => {
    const n = Number(params.n);
    const r = await service.receivePart(acc, params.id, n, req, partDigest(req));
    ok(res, r);
  });
  router.add('PUT', `${API}/uploads/:id/parts/:n`, part);
  router.add('POST', `${API}/uploads/:id/parts/:n`, part);
  router.add('POST', `${API}/uploads/:id/complete`, authed(async (req, res, { acc, params }) => {
    const b = await json(req);
    const u = await service.completeUpload(acc, params.id, b);
    ok(res, { upload: u, file: u.file, quota: service.quota(acc) });
  }));
  router.add('DELETE', `${API}/uploads/:id`, authed(async (req, res, { acc, params }) => {
    ok(res, { upload: await service.abortUpload(acc, params.id), quota: service.quota(acc) });
  }));

  // --------------------------------------------------- solo modo desarrollo
  if (cfg.account.mode === 'dev') {
    const dev = gateway;
    const cookie = (token, maxAge) => `${DEV_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax${cfg.publicUrl.startsWith('https://') ? '; Secure' : ''}; Max-Age=${maxAge}`;
    if (cfg.account.devLogin) {
      router.add('POST', `${API}/dev/login`, async (req, res) => {
        const b = await json(req);
        const addr = typeof b.flexAddress === 'string' && /^[a-z0-9._-]{1,40}@flex$/.test(b.flexAddress) ? b.flexAddress : 'usuario@flex';
        const id = dev.createAccount({ flexAddress: addr, displayName: typeof b.displayName === 'string' ? b.displayName.slice(0, 60) : 'Usuario Flex' });
        res.setHeader('Set-Cookie', cookie(dev.createSession(id), 7 * 86400));
        ok(res, { dev: true });
      });
    }
    router.add('POST', `${API}/dev/logout`, async (req, res) => {
      res.setHeader('Set-Cookie', cookie('', 0));
      ok(res, {});
    });
    // Registra la huella de una credencial de dispositivo en la cuenta de la
    // sesion: es lo que hace Flex Account al aprobar el codigo del P4.
    router.add('POST', `${API}/dev/devices`, authed(async (req, res, { acc }) => {
      const b = await json(req);
      if (!/^[a-f0-9]{64}$/.test(String(b.tokenHash))) throw E.invalid('tokenHash no valido');
      dev.registerDevice(acc, b.tokenHash, typeof b.label === 'string' ? b.label.slice(0, 60) : 'Flex OS Ultra', Number.isSafeInteger(b.expiresAt) ? b.expiresAt : null);
      ok(res, { registered: true });
    }));
  }

  // ---------------------------------------------------------- envio de bytes
  async function sendFile(req, res, f, inline) {
    const safeInline = inline && inlineSafe(f.mime);
    await sendObject(req, res, {
      key: f.storage_key, size: f.size, mime: f.mime, name: f.name, inline: safeInline,
      etag: `"${f.sha256}"`, lastModified: f.updated_at, download: true,
    });
  }

  async function sendObject(req, res, o) {
    const size = o.size;
    let range = null;
    const ifRange = req.headers['if-range'];
    if (!ifRange || ifRange === o.etag) range = parseRange(req.headers.range, size);
    if (size === 0) range = null;
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('ETag', o.etag);
    if (o.lastModified) res.setHeader('Last-Modified', new Date(o.lastModified).toUTCString());
    // Nunca se interpreta un archivo del usuario como pagina de este dominio.
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Content-Type', o.inline ? o.mime : (inlineSafe(o.mime) ? o.mime : 'application/octet-stream'));
    if (o.download) res.setHeader('Content-Disposition', contentDisposition(o.name, o.inline));
    if (o.download) res.setHeader('Cache-Control', 'private, no-cache');
    if (range) {
      res.statusCode = 206;
      res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
      res.setHeader('Content-Length', range.end - range.start + 1);
    } else {
      res.statusCode = 200;
      res.setHeader('Content-Length', size);
    }
    if (req.method === 'HEAD' || size === 0) { res.end(); return; }
    const stream = service.store.read(o.key, range ? range.start : 0, range ? range.end : size - 1);
    try {
      await pipeline(stream, res);
    } catch (e) {
      // El cliente corto (Wi-Fi perdido, salto en el video): no es un error.
      if (e.code !== 'ERR_STREAM_PREMATURE_CLOSE') log('warn', 'descarga interrumpida', { err: e.code || e.message });
      stream.destroy();
    }
  }

  // -------------------------------------------------------------- estaticos
  async function serveStatic(req, res, path) {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.statusCode = 405; res.end(); return; }
    let rel = decodeURIComponent(path);
    if (rel === '/' || !extname(rel)) rel = '/index.html';           // SPA
    const file = normalize(join(cfg.webDir, rel));
    if (!file.startsWith(cfg.webDir + sep)) { res.statusCode = 404; res.end(); return; }
    let st;
    try { st = await stat(file); } catch { res.statusCode = 404; res.end('No encontrado'); return; }
    if (!st.isFile()) { res.statusCode = 404; res.end(); return; }
    const etag = `"w-${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    res.setHeader('Content-Type', STATIC_TYPES[extname(file)] || 'application/octet-stream');
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', rel === '/index.html' ? 'no-cache' : 'public, max-age=300');
    if (extname(file) === '.html') res.setHeader('Content-Security-Policy', WEB_CSP);
    if (req.headers['if-none-match'] === etag) { res.statusCode = 304; res.end(); return; }
    res.setHeader('Content-Length', st.size);
    if (req.method === 'HEAD') { res.end(); return; }
    await pipeline(createReadStream(file), res).catch(() => {});
  }

  // ----------------------------------------------------------- despachador
  return async function handle(req, res) {
    const started = Date.now();
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { res.statusCode = 400; res.end(); return; }
    const path = url.pathname;
    const isApi = path === API || path.startsWith(API + '/');
    securityHeaders(res, { api: isApi });
    try {
      if (!isApi) { await serveStatic(req, res, path); return; }
      const m = router.match(req.method, path);
      if (!m) throw E.notFound('La ruta');
      if (m.allowed) { res.setHeader('Allow', m.allowed.join(', ')); throw new CloudError(405, 'method_not_allowed', 'Metodo no permitido.'); }
      await m.route.handler(req, res, { params: m.route.keys.length ? m.params : {}, url });
    } catch (err) {
      const { status, body } = errorBody(err);
      if (status >= 500) log('error', 'fallo en la API', { path, method: req.method, err: err.stack || err.message });
      if (!res.headersSent) {
        // Si llega un error a mitad de recibir un cuerpo grande, se cierra la
        // conexion: no se leen megas que se van a tirar.
        if (!req.complete) res.setHeader('Connection', 'close');
        sendJson(res, status, body);
      } else res.destroy();
      if (!req.complete) req.resume();
    } finally {
      if (isApi && cfg.logLevel === 'debug') log('debug', 'peticion', { method: req.method, path, status: res.statusCode, ms: Date.now() - started });
    }
  };
}
