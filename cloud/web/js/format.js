// Formatos para personas: tamanos en la unidad del sistema (base 1024, como
// Flex OS), fechas relativas y nombres de tipo en espanol.
const nf1 = new Intl.NumberFormat('es', { maximumFractionDigits: 1 });
const nf0 = new Intl.NumberFormat('es', { maximumFractionDigits: 0 });

export function bytes(n) {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${(v >= 100 ? nf0 : nf1).format(v)} ${u[i]}`;
}

const rtf = new Intl.RelativeTimeFormat('es', { numeric: 'auto' });
const dtf = new Intl.DateTimeFormat('es', { day: 'numeric', month: 'short', year: 'numeric' });
const dtfFull = new Intl.DateTimeFormat('es', { dateStyle: 'long', timeStyle: 'short' });
export function when(ms, now = Date.now()) {
  const d = (ms - now) / 1000;
  const a = Math.abs(d);
  if (a < 45) return 'ahora';
  if (a < 3600) return rtf.format(Math.round(d / 60), 'minute');
  if (a < 86400) return rtf.format(Math.round(d / 3600), 'hour');
  if (a < 7 * 86400) return rtf.format(Math.round(d / 86400), 'day');
  return dtf.format(ms);
}
export const fullDate = (ms) => dtfFull.format(ms);

export function duration(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '';
  if (sec < 60) return `${Math.max(1, Math.round(sec))} s`;
  const m = Math.floor(sec / 60), s = Math.round(sec % 60);
  if (m < 60) return `${m} min ${s ? s + ' s' : ''}`.trim();
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

export const KIND_LABEL = { folder: 'Carpeta', photo: 'Imagen', video: 'Vídeo', audio: 'Audio', document: 'Documento', archive: 'Archivo comprimido', other: 'Archivo' };

export function kindOfMime(mime = '') {
  if (mime.startsWith('image/')) return 'photo';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime === 'application/pdf' || mime.startsWith('text/')) return 'document';
  return 'other';
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function initials(name = '') {
  const parts = name.replace(/@flex$/, '').split(/[\s._-]+/).filter(Boolean);
  return ((parts[0]?.[0] || 'F') + (parts[1]?.[0] || '')).toUpperCase();
}
