// Subidas y descargas de Flex Cloud en el navegador.
//
// SUBIDAS. Por partes de 8 MB, tres a la vez por archivo y dos archivos a la
// vez. Cada parte lleva su SHA-256 (WebCrypto) y el servidor la rechaza si no
// cuadra. Si se va el Wi-Fi, la subida espera a que vuelva y sigue por la parte
// en la que iba; si el servidor falla, reintenta con espera creciente (1 s ..
// 30 s) y se rinde tras varios fallos seguidos, dejando "Reintentar". Si se
// recarga la pagina, la sesion sigue en el servidor: al volver a elegir el
// mismo archivo continua donde se quedo (el navegador no deja reabrir un
// archivo del disco sin que la persona lo elija).
//
// DESCARGAS. Con la API de archivos del sistema (Chrome/Edge) van directas al
// disco en streaming y se reanudan con Range si se corta la red. Sin ella, los
// archivos medianos se bajan con progreso y los enormes se dejan al gestor de
// descargas del navegador, que ya sabe reanudar.
import { api, ApiError } from './api.js';
import { makeThumb } from './thumbs.js';

const PART = 8 * 1024 * 1024;
const PARALLEL_PARTS = 3;
const PARALLEL_FILES = 2;
const MAX_FAILS = 8;
const BLOB_DOWNLOAD_MAX = 300 * 1024 * 1024;
const STORE = 'flexcloud.uploads.v1';

class Stop extends Error {}

function fnv1a(s) {
  let h = 0x811c9dc5;
  for (const ch of s) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}
const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadStore() { try { return JSON.parse(localStorage.getItem(STORE) || '[]'); } catch { return []; } }
function saveStore(list) { try { localStorage.setItem(STORE, JSON.stringify(list.slice(-50))); } catch { /* almacenamiento lleno o privado */ } }

let seq = 0;

export class Transfers extends EventTarget {
  constructor() {
    super();
    this.tasks = new Map();
    this.online = navigator.onLine !== false;
    this.wakers = new Set();
    this.raf = 0;
    addEventListener('online', () => { this.online = true; this.#wake(); this.changed(); });
    addEventListener('offline', () => { this.online = false; this.changed(); });
    setInterval(() => { for (const t of this.tasks.values()) if (t.state === 'uploading' || t.state === 'downloading') this.#sample(t); }, 1000);
  }

  changed() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => { this.raf = 0; this.dispatchEvent(new Event('change')); });
  }
  list() { return [...this.tasks.values()]; }
  active() { return this.list().filter((t) => !['done', 'cancelled', 'error'].includes(t.state)); }

  #wake() { for (const w of this.wakers) w(); this.wakers.clear(); }
  #waitWake(ms) { return new Promise((r) => { const done = () => { clearTimeout(timer); r(); }; const timer = setTimeout(() => { this.wakers.delete(done); r(); }, ms); this.wakers.add(done); }); }

  #sample(t) {
    const now = performance.now();
    const b = this.#bytes(t);
    t.samples.push([now, b]);
    while (t.samples.length > 6) t.samples.shift();
    if (t.samples.length >= 2) {
      const [t0, b0] = t.samples[0];
      t.rate = Math.max(0, (b - b0) / ((now - t0) / 1000));
    }
    this.changed();
  }
  #bytes(t) {
    if (t.type === 'download') return t.done;
    let inflight = 0;
    for (const v of t.inflight.values()) inflight += v;
    return Math.min(t.size, t.sent + inflight);
  }
  progressOf(t) { return t.size ? this.#bytes(t) / t.size : (t.state === 'done' ? 1 : 0); }
  bytesOf(t) { return this.#bytes(t); }

  // --------------------------------------------------------------- subidas
  addUpload(file, parentId, extra = {}) {
    const t = {
      id: `t${++seq}`, type: 'upload', file, name: extra.name || file.name, size: file.size, parentId: parentId || null,
      state: 'queued', sent: 0, inflight: new Map(), xhrs: new Set(), received: new Set(), fails: 0, rate: 0, samples: [],
      clientKey: `web:${file.size}:${file.lastModified || 0}:${fnv1a((extra.name || file.name) + '|' + (parentId || 'root'))}`,
      uploadId: extra.uploadId || null, error: null, fileId: null, retryAt: 0, paused: false, cancelled: false, startedAt: Date.now(),
    };
    this.tasks.set(t.id, t);
    this.changed();
    this.#pump();
    return t;
  }

  #pump() {
    const running = this.list().filter((t) => t.type === 'upload' && ['preparing', 'uploading', 'completing', 'retrying', 'waiting'].includes(t.state)).length;
    let slots = PARALLEL_FILES - running;
    for (const t of this.tasks.values()) {
      if (slots <= 0) break;
      if (t.type === 'upload' && t.state === 'queued') { slots--; this.#runUpload(t); }
    }
  }

  #persist(t, remove = false) {
    const list = loadStore().filter((e) => e.uploadId !== t.uploadId);
    if (!remove && t.uploadId) list.push({ uploadId: t.uploadId, clientKey: t.clientKey, name: t.name, size: t.size, lastModified: t.file?.lastModified || 0, parentId: t.parentId });
    saveStore(list);
  }

  // Espera a que se pueda seguir: sin pausa, con red y pasado el reintento.
  async #ready(t) {
    for (;;) {
      if (t.cancelled) throw new Stop();
      if (t.paused) { t.state = 'paused'; this.changed(); await this.#waitWake(60_000); continue; }
      if (!this.online) { t.state = 'waiting'; this.changed(); await this.#waitWake(30_000); continue; }
      const left = t.retryAt - Date.now();
      if (left > 0) { t.state = 'retrying'; this.changed(); await this.#waitWake(left); continue; }
      if (t.state !== 'completing') t.state = 'uploading';
      return;
    }
  }

  #transient(e) {
    if (!(e instanceof ApiError)) return true;
    return e.offline || e.status === 0 || e.status >= 500 || e.status === 429 || e.code === 'checksum_mismatch' || e.code === 'part_busy';
  }

  #fail(t, e) {
    if (e instanceof Stop) return;
    if (this.#transient(e) && t.fails < MAX_FAILS) {
      t.fails++;
      t.retryAt = Date.now() + Math.min(30_000, 1000 * 2 ** (t.fails - 1));
      return 'retry';
    }
    t.state = 'error';
    t.error = e.code === 'quota_exceeded' ? 'No queda espacio en tu Flex Cloud.'
      : e.code === 'part_conflict' || e.name === 'NotReadableError' ? 'El archivo cambió mientras se subía. Vuelve a subirlo.'
      : e.status === 401 ? 'Tu sesión caducó. Vuelve a iniciar sesión.'
      : e.message || 'No se pudo subir.';
    this.changed();
    return 'fatal';
  }

  async #runUpload(t) {
    t.state = 'preparing'; t.error = null; this.changed();
    try {
      let u;
      for (;;) {
        await this.#ready(t);
        try {
          if (t.uploadId) {
            u = (await api.uploadStatus(t.uploadId)).upload;
            if (['expired', 'aborted', 'failed'].includes(u.state)) { this.#persist(t, true); t.uploadId = null; continue; }
          } else {
            const meta = {};
            u = (await api.createUpload({ name: t.name, size: t.size, mimeType: t.file.type || undefined, parentId: t.parentId, chunkSize: PART, clientKey: t.clientKey, metadata: meta })).upload;
            t.uploadId = u.uploadId;
            this.#persist(t);
          }
          break;
        } catch (e) {
          if (e instanceof ApiError && e.code === 'upload_not_found') { this.#persist(t, true); t.uploadId = null; continue; }
          if (this.#fail(t, e) !== 'retry') throw new Stop();
        }
      }
      t.chunk = u.chunkSize; t.totalParts = u.totalParts;
      t.received = new Set(u.receivedParts); t.sent = u.receivedBytes;
      if (u.state === 'completed') return this.#finish(t, u.file);
      t.state = 'uploading'; t.fails = 0; this.changed();

      const queue = [];
      for (let n = 1; n <= t.totalParts; n++) if (!t.received.has(n)) queue.push(n);
      const worker = async () => {
        while (queue.length) {
          await this.#ready(t);
          const n = queue.shift();
          if (n === undefined) return;
          try {
            await this.#putPart(t, n);
            t.fails = 0;
          } catch (e) {
            t.inflight.delete(n);
            if (e instanceof Stop) throw e;
            if (e.name === 'AbortError') { queue.unshift(n); continue; }        // pausa o cancelacion
            if (this.#fail(t, e) === 'retry') { queue.unshift(n); continue; }
            throw new Stop();
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(PARALLEL_PARTS, Math.max(1, queue.length)) }, worker));

      for (;;) {
        t.state = 'completing'; this.changed();
        await this.#ready(t);
        try {
          const r = await api.completeUpload(t.uploadId);
          return this.#finish(t, r.file);
        } catch (e) {
          if (e instanceof ApiError && e.code === 'incomplete_upload') {
            // El servidor perdio alguna parte (p. ej. restaurado de copia): se
            // vuelven a mandar solo esas.
            for (const n of e.details?.missing || []) { t.received.delete(n); await this.#putPart(t, n); }
            continue;
          }
          if (e instanceof ApiError && e.code === 'upload_state' && e.details?.state === 'completing') { await sleep(1500); continue; }
          if (this.#fail(t, e) !== 'retry') throw new Stop();
        }
      }
    } catch (e) {
      if (!(e instanceof Stop)) this.#fail(t, e);
    } finally {
      for (const x of t.xhrs) x.abort();
      t.xhrs.clear(); t.inflight.clear();
      this.changed();
      this.#pump();
    }
  }

  async #putPart(t, n) {
    const start = (n - 1) * t.chunk;
    const end = Math.min(t.size, start + t.chunk);
    const buf = await t.file.slice(start, end).arrayBuffer();
    const digest = hex(await crypto.subtle.digest('SHA-256', buf));
    if (t.cancelled) throw new Stop();
    await new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      t.xhrs.add(x);
      x.open('PUT', api.partUrl(t.uploadId, n));
      x.setRequestHeader('x-flex-cloud', '1');
      x.setRequestHeader('x-part-sha256', digest);
      x.setRequestHeader('content-type', 'application/octet-stream');
      x.timeout = 180_000;
      x.upload.onprogress = (e) => { t.inflight.set(n, e.loaded); };
      x.onload = () => {
        t.xhrs.delete(x);
        let data = null;
        try { data = JSON.parse(x.responseText); } catch { /* sin JSON */ }
        if (x.status >= 200 && x.status < 300 && data?.ok) resolve(data);
        else reject(new ApiError(x.status, data?.error?.code || `http_${x.status}`, data?.error?.message || `Flex Cloud respondió ${x.status}.`, data?.error?.details));
      };
      x.onerror = () => { t.xhrs.delete(x); reject(new ApiError(0, 'network', 'Se perdio la conexión.')); };
      x.ontimeout = () => { t.xhrs.delete(x); reject(new ApiError(0, 'network', 'La red no responde.')); };
      x.onabort = () => { t.xhrs.delete(x); reject(new DOMException('cancelado', 'AbortError')); };
      x.send(buf);
    });
    t.inflight.delete(n);
    if (!t.received.has(n)) { t.received.add(n); t.sent += end - start; }
    this.changed();
  }

  async #finish(t, file) {
    t.state = 'done'; t.fileId = file?.id; t.sent = t.size; t.finishedAt = Date.now();
    this.#persist(t, true);
    this.changed();
    this.dispatchEvent(new CustomEvent('uploaded', { detail: { task: t, file } }));
    // Miniatura en segundo plano: objeto aparte, el original no se toca.
    if (file?.id && t.file) {
      const th = await makeThumb(t.file);
      if (th?.blob) {
        try { await api.putThumb(file.id, th.blob); this.dispatchEvent(new CustomEvent('thumb', { detail: { fileId: file.id } })); } catch { /* opcional */ }
      }
    }
  }

  pause(id) {
    const t = this.tasks.get(id);
    if (!t) return;
    t.paused = true;
    for (const x of t.xhrs) x.abort();
    if (t.abort) t.abort.abort();
    t.state = 'paused';
    this.changed();
  }
  resume(id) {
    const t = this.tasks.get(id);
    if (!t) return;
    t.paused = false; t.retryAt = 0;
    this.#wake(); this.changed();
  }
  async cancel(id) {
    const t = this.tasks.get(id);
    if (!t) return;
    t.cancelled = true; t.paused = false;
    for (const x of t.xhrs) x.abort();
    if (t.abort) t.abort.abort();
    this.#wake();
    t.state = 'cancelled';
    this.changed();
    if (t.type === 'upload' && t.uploadId) {
      this.#persist(t, true);
      try { await api.abortUpload(t.uploadId); } catch { /* caducara sola */ }
    }
    if (t.type === 'download' && t.writable) { try { await t.writable.abort(); } catch { /* ya cerrado */ } }
  }
  retry(id) {
    const t = this.tasks.get(id);
    if (!t || t.state !== 'error') return;
    t.fails = 0; t.retryAt = 0; t.error = null;
    if (t.type === 'upload') { t.state = 'queued'; this.#pump(); } else this.#runDownload(t);
    this.changed();
  }
  dismiss(id) { this.tasks.delete(id); this.changed(); }
  clearFinished() { for (const [k, t] of this.tasks) if (['done', 'cancelled'].includes(t.state)) this.tasks.delete(k); this.changed(); }

  // Subidas que quedaron a medias en una visita anterior.
  async restorePending() {
    const local = loadStore();
    if (!local.length) return;
    let server = [];
    try { server = (await api.uploads()).uploads; } catch { return; }
    const live = new Map(server.map((u) => [u.uploadId, u]));
    const keep = [];
    for (const e of local) {
      const u = live.get(e.uploadId);
      if (!u) continue;
      keep.push(e);
      const t = {
        id: `t${++seq}`, type: 'upload', file: null, name: e.name, size: e.size, parentId: e.parentId, state: 'needsFile',
        sent: u.receivedBytes, inflight: new Map(), xhrs: new Set(), received: new Set(u.receivedParts), fails: 0, rate: 0, samples: [],
        clientKey: e.clientKey, uploadId: e.uploadId, lastModified: e.lastModified, error: null, paused: false, cancelled: false,
      };
      this.tasks.set(t.id, t);
    }
    saveStore(keep);
    this.changed();
  }
  attachFile(id, file) {
    const t = this.tasks.get(id);
    if (!t || t.state !== 'needsFile') return false;
    if (file.name !== t.name || file.size !== t.size || (t.lastModified && file.lastModified !== t.lastModified)) return false;
    t.file = file; t.state = 'queued';
    this.#pump(); this.changed();
    return true;
  }

  // ------------------------------------------------------------- descargas
  // Debe llamarse DENTRO del gesto del usuario (el selector de destino lo exige).
  async download(f) {
    if (window.showSaveFilePicker && f.size > 4 * 1024 * 1024) {
      let handle;
      try { handle = await window.showSaveFilePicker({ suggestedName: f.name }); } catch (e) { if (e.name === 'AbortError') return null; handle = null; }
      if (handle) return this.#startDownload(f, { handle });
    }
    if (f.size <= BLOB_DOWNLOAD_MAX) return this.#startDownload(f, {});
    // Enorme y sin API de archivos: el gestor del navegador (reanuda solo).
    const a = document.createElement('a');
    a.href = api.downloadUrl(f.id); a.download = f.name; a.rel = 'noopener';
    document.body.append(a); a.click(); a.remove();
    return 'native';
  }

  #startDownload(f, { handle }) {
    const t = { id: `t${++seq}`, type: 'download', name: f.name, size: f.size, fileId: f.id, etag: `"${f.sha256}"`, kind: f.kind,
                state: 'downloading', done: 0, rate: 0, samples: [], fails: 0, handle, chunks: handle ? null : [], error: null };
    this.tasks.set(t.id, t);
    this.changed();
    this.#runDownload(t);
    return t;
  }

  async #runDownload(t) {
    try {
      if (t.handle && !t.writable) t.writable = await t.handle.createWritable();
      while (t.done < t.size || t.size === 0) {
        if (t.cancelled) return;
        if (t.paused) { t.state = 'paused'; this.changed(); await this.#waitWake(60_000); continue; }
        if (!this.online) { t.state = 'waiting'; this.changed(); await this.#waitWake(30_000); continue; }
        t.state = 'downloading'; this.changed();
        t.abort = new AbortController();
        try {
          const headers = t.done ? { range: `bytes=${t.done}-`, 'if-range': t.etag } : {};
          const res = await fetch(api.downloadUrl(t.fileId), { headers, credentials: 'same-origin', signal: t.abort.signal });
          if (!res.ok) throw new ApiError(res.status, `http_${res.status}`, res.status === 404 ? 'El archivo ya no existe.' : `Flex Cloud respondió ${res.status}.`);
          if (t.done && res.status !== 206) {
            // El archivo cambio: se empieza de cero, nunca se mezclan versiones.
            t.done = 0;
            if (t.writable) { await t.writable.truncate(0); await t.writable.seek(0); } else t.chunks = [];
          }
          const reader = res.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (t.writable) await t.writable.write(value); else t.chunks.push(value);
            t.done += value.length;
            t.fails = 0;
          }
          if (t.size === 0) break;
        } catch (e) {
          if (t.cancelled) return;
          if (e.name === 'AbortError') continue;                 // pausa
          if (e instanceof ApiError && e.status === 404) throw e;
          t.fails++;
          if (t.fails > MAX_FAILS) throw e;
          t.state = 'retrying'; this.changed();
          await this.#waitWake(Math.min(30_000, 1000 * 2 ** (t.fails - 1)));
        }
      }
      if (t.writable) { await t.writable.close(); t.writable = null; }
      else {
        const blob = new Blob(t.chunks);
        t.chunks = null;
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = t.name; document.body.append(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      }
      t.state = 'done'; t.finishedAt = Date.now();
    } catch (e) {
      t.state = 'error';
      t.error = e.message || 'No se pudo descargar.';
    } finally {
      this.changed();
    }
  }
}

export const transfers = new Transfers();
