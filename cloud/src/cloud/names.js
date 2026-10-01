// Nombres, identificadores, tipos MIME y cabeceras de descarga.
//
// Los nombres de archivo son TEXTO del usuario: se guardan tal cual (NFC) con
// tildes, enie, emojis y espacios, sin "limpiarlos" a ASCII. Solo se rechaza
// lo que no puede ser un nombre en ningun sistema: separadores de ruta, NUL y
// caracteres de control, "." y "..", y nombres de mas de 255 bytes UTF-8.
import { randomBytes } from 'node:crypto';
import { E } from '../http/errors.js';

export const MAX_NAME_BYTES = 255;

export function newId(prefix) {
  // 120 bits aleatorios en base32 minuscula: no adivinables ni enumerables.
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  const bytes = randomBytes(15);
  let bits = 0, acc = 0, out = '';
  for (const b of bytes) {
    acc = (acc << 8) | b; bits += 8;
    while (bits >= 5) { bits -= 5; out += alphabet[(acc >> bits) & 31]; }
  }
  return `${prefix}_${out}`;
}

export const ID_RE = {
  file: /^fil_[a-z2-7]{24}$/,
  folder: /^fld_[a-z2-7]{24}$/,
  upload: /^upl_[a-z2-7]{24}$/,
};

export function normalizeName(raw) {
  if (typeof raw !== 'string') throw E.nameInvalid('El nombre es obligatorio.');
  const name = raw.normalize('NFC').trim();
  if (!name) throw E.nameInvalid('El nombre no puede estar vacio.');
  if (name === '.' || name === '..') throw E.nameInvalid('Ese nombre esta reservado.');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f/\\]/.test(name)) throw E.nameInvalid('El nombre no puede contener "/", "\\" ni caracteres de control.');
  if (/[\u202a-\u202e\u2066-\u2069]/.test(name)) throw E.nameInvalid('El nombre contiene caracteres de control de direccion de texto.');
  if (Buffer.byteLength(name, 'utf8') > MAX_NAME_BYTES) throw E.nameInvalid('El nombre es demasiado largo (maximo 255 bytes).');
  // Pares sustitutos sueltos (texto UTF-16 roto) no son un nombre valido.
  if (!name.isWellFormed()) throw E.nameInvalid('El nombre no es texto Unicode valido.');
  return name;
}

// Clave de unicidad: dos nombres que solo difieren en mayusculas (o en la
// forma Unicode) chocarian al bajarlos a un disco que no las distingue.
export function nameKey(name) { return name.normalize('NFC').toLocaleLowerCase('und'); }

export function splitExt(name) {
  const i = name.lastIndexOf('.');
  if (i <= 0 || i === name.length - 1) return [name, ''];
  return [name.slice(0, i), name.slice(i)];
}

// "foto.jpg" -> "foto (1).jpg" -> "foto (2).jpg"... sin pasar de 255 bytes.
export function numberedName(name, n) {
  const [stem, ext] = splitExt(name);
  const suffix = ` (${n})`;
  let s = stem;
  while (Buffer.byteLength(s + suffix + ext, 'utf8') > MAX_NAME_BYTES && s.length) s = Array.from(s).slice(0, -1).join('');
  return s + suffix + ext;
}

const MIME_BY_EXT = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp',
  '.heic': 'image/heic', '.heif': 'image/heif', '.bmp': 'image/bmp', '.svg': 'image/svg+xml', '.avif': 'image/avif',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo', '.3gp': 'video/3gpp',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.flac': 'audio/flac', '.opus': 'audio/opus',
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.json': 'application/json',
  '.zip': 'application/zip', '.7z': 'application/x-7z-compressed', '.rar': 'application/vnd.rar', '.gz': 'application/gzip',
  '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.html': 'text/html', '.htm': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.flexpkg': 'application/x-flexpkg', '.fxp': 'application/x-flex-paint', '.bin': 'application/octet-stream',
};

export function mimeFor(name, declared) {
  const ext = splitExt(name)[1].toLowerCase();
  if (typeof declared === 'string' && /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,127}$/i.test(declared)
      && declared !== 'application/octet-stream') {
    return declared.toLowerCase();
  }
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}

export function kindFor(mime) {
  if (mime.startsWith('image/')) return 'photo';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime === 'application/pdf' || mime.startsWith('text/') || mime.includes('document') || mime.includes('sheet') ||
      mime.includes('presentation') || mime === 'application/msword' || mime === 'application/vnd.ms-excel') return 'document';
  if (mime.includes('zip') || mime.includes('compressed') || mime.includes('rar') || mime.includes('gzip')) return 'archive';
  return 'other';
}

// Tipos que el navegador podria EJECUTAR (HTML, SVG, XML, JS) si se sirvieran
// en linea desde nuestro dominio: se fuerzan siempre a descarga.
const ACTIVE = /^(text\/html|application\/xhtml\+xml|image\/svg\+xml|text\/xml|application\/xml|text\/javascript|application\/javascript)$/;
export function inlineSafe(mime) {
  if (ACTIVE.test(mime)) return false;
  return /^(image|video|audio)\//.test(mime) || mime === 'application/pdf' || mime === 'text/plain';
}

// RFC 6266 / 5987: nombre ASCII de respaldo + filename* con el nombre real.
export function contentDisposition(name, inline) {
  const fallback = name.normalize('NFKD').replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_').replace(/[;\r\n]/g, '_') || 'archivo';
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `${inline ? 'inline' : 'attachment'}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
