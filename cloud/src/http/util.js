// Utilidades HTTP: cuerpo JSON acotado, respuestas, rangos y cabeceras.
import { E } from './errors.js';

export function securityHeaders(res, { api = true } = {}) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), interest-cohort=()');
  if (api) res.setHeader('Cache-Control', 'no-store');
}

export function sendJson(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', body.length);
  res.end(body);
}

export async function readJson(req, maxBytes) {
  const type = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > maxBytes) throw E.payloadTooLarge();
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > maxBytes) throw E.payloadTooLarge();
    chunks.push(c);
  }
  if (!size) return {};
  if (type !== 'application/json') throw E.invalid('El cuerpo debe ser application/json.');
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error();
    return v;
  } catch { throw E.invalid('JSON no válido.'); }
}

export async function readBuffer(req, maxBytes) {
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > maxBytes) throw E.payloadTooLarge();
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > maxBytes) throw E.payloadTooLarge();
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

// Un solo rango "bytes=a-b", "bytes=a-" o "bytes=-n". Varios rangos a la vez
// (multipart/byteranges) no los pide ningun cliente de Flex: se sirve entero.
export function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m) return null;
  let start, end;
  if (m[1] === '' && m[2] === '') return null;
  if (m[1] === '') {
    const n = Number(m[2]);
    if (!n) throw E.range(size);
    start = Math.max(0, size - n); end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) throw E.range(size);
  return { start, end };
}

// SHA-256 declarado de una parte: X-Part-SHA256 (hex) o Content-Digest
// (RFC 9530, "sha-256=:base64:").
export function partDigest(req) {
  const hex = req.headers['x-part-sha256'];
  if (typeof hex === 'string' && hex.trim()) return hex.trim().toLowerCase();
  const cd = req.headers['content-digest'];
  if (typeof cd === 'string') {
    const m = /sha-256=:([A-Za-z0-9+/=]+):/i.exec(cd);
    if (m) return Buffer.from(m[1], 'base64').toString('hex');
  }
  return null;
}

export function clientIp(req, trustProxy) {
  if (trustProxy) {
    const f = req.headers['x-forwarded-for'];
    if (typeof f === 'string' && f) return f.split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

// Limitador sencillo por clave (ventana fija). Frena la fuerza bruta contra
// credenciales sin depender de nada externo.
export class RateLimiter {
  constructor({ windowMs, max, now = Date.now }) { this.windowMs = windowMs; this.max = max; this.now = now; this.map = new Map(); }
  hit(key) {
    const t = this.now();
    let e = this.map.get(key);
    if (!e || e.reset <= t) { e = { n: 0, reset: t + this.windowMs }; this.map.set(key, e); }
    e.n++;
    if (this.map.size > 20000) for (const [k, v] of this.map) if (v.reset <= t) this.map.delete(k);
    return e.n <= this.max;
  }
  blocked(key) { const e = this.map.get(key); return !!(e && e.reset > this.now() && e.n > this.max); }
}
