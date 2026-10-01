// Logica de Flex Cloud: cuentas y cuota, carpetas, archivos, papelera y
// subidas reanudables. Toda consulta lleva `account_id = ?` con la cuenta que
// devolvio Flex Account: no hay forma de nombrar un elemento de otra cuenta.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { E, CloudError } from '../http/errors.js';
import { newStorageKey } from '../storage/objectStore.js';
import { ID_RE, kindFor, mimeFor, nameKey, newId, normalizeName, numberedName } from './names.js';

const ROOT = '';
const MAX_DEPTH = 64;
const PAGE_MAX = 200;
const META_KEYS = { width: 'int', height: 'int', durationMs: 'int', takenAt: 'int', orientation: 'int',
                    device: 'str', localPath: 'str', origin: 'str' };

function cleanMeta(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  for (const [k, t] of Object.entries(META_KEYS)) {
    const v = raw[k];
    if (v === undefined || v === null) continue;
    if (t === 'int' && Number.isSafeInteger(v) && v >= 0) out[k] = v;
    if (t === 'str' && typeof v === 'string' && v.length <= 200) out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

function isHex64(s) { return typeof s === 'string' && /^[a-f0-9]{64}$/.test(s); }
function encodeCursor(o) { return Buffer.from(JSON.stringify({ o })).toString('base64url'); }
function decodeCursor(c) {
  if (!c) return 0;
  try { const { o } = JSON.parse(Buffer.from(String(c), 'base64url').toString('utf8')); return Number.isSafeInteger(o) && o >= 0 ? o : 0; } catch { return 0; }
}

export class CloudService {
  constructor({ db, store, cfg, now = Date.now, log = () => {} }) {
    this.db = db; this.store = store; this.cfg = cfg; this.now = now; this.log = log;
    this.partLocks = new Map();
    this.completing = new Set();
  }

  // -------------------------------------------------------------- cuentas
  ensureAccount(identity) {
    const a = identity.account;
    const t = this.now();
    const plan = a.plan && this.cfg.plans[a.plan] ? a.plan : null;
    const row = this.db.get('SELECT * FROM accounts WHERE id = ?', a.id);
    if (!row) {
      this.db.run(`INSERT INTO accounts (id, flex_address, display_name, plan, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?)`, a.id, a.flexAddress, a.displayName, plan || this.cfg.defaultPlan, t, t);
    } else if (row.flex_address !== a.flexAddress || row.display_name !== a.displayName || (plan && row.plan !== plan)) {
      this.db.run('UPDATE accounts SET flex_address = ?, display_name = ?, plan = ?, updated_at = ? WHERE id = ?',
        a.flexAddress, a.displayName, plan || row.plan, t, a.id);
    }
    return a.id;
  }

  totalFor(row) {
    if (Number.isSafeInteger(row.quota_override) && row.quota_override > 0) return row.quota_override;
    return this.cfg.plans[row.plan] ?? this.cfg.plans[this.cfg.defaultPlan];
  }

  quota(accountId) {
    const row = this.db.get('SELECT * FROM accounts WHERE id = ?', accountId);
    const total = this.totalFor(row);
    const trash = this.db.get('SELECT IFNULL(SUM(size), 0) AS s FROM files WHERE account_id = ? AND deleted_at IS NOT NULL', accountId).s;
    const committed = row.used_bytes + row.reserved_bytes;
    const available = Math.max(0, total - committed);
    const ratio = total ? committed / total : 1;
    return {
      plan: row.plan,
      totalBytes: total,
      usedBytes: row.used_bytes,
      reservedBytes: row.reserved_bytes,
      trashBytes: trash,
      availableBytes: available,
      percentUsed: Math.min(100, Math.round(ratio * 1000) / 10),
      state: available <= 0 ? 'full' : ratio >= this.cfg.lowSpaceRatio ? 'low' : 'ok',
      plans: this.cfg.plans,
    };
  }

  // ------------------------------------------------------------- carpetas
  #liveFolder(accountId, id) {
    if (id === null || id === undefined || id === '' || id === 'root') return null;
    if (!ID_RE.folder.test(id)) throw E.notFound('La carpeta');
    const f = this.db.get('SELECT * FROM folders WHERE id = ? AND account_id = ? AND deleted_at IS NULL', id, accountId);
    if (!f) throw E.notFound('La carpeta');
    return f;
  }

  #parentId(accountId, raw) {
    const f = this.#liveFolder(accountId, raw);
    return f ? f.id : null;
  }

  #nameTaken(accountId, parentId, key, exceptId = null) {
    const p = parentId ?? ROOT;
    const a = this.db.get(`SELECT id FROM folders WHERE account_id = ? AND IFNULL(parent_id, '') = ? AND name_key = ? AND deleted_at IS NULL`, accountId, p, key);
    if (a && a.id !== exceptId) return true;
    const b = this.db.get(`SELECT id FROM files WHERE account_id = ? AND IFNULL(parent_id, '') = ? AND name_key = ? AND deleted_at IS NULL`, accountId, p, key);
    return !!(b && b.id !== exceptId);
  }

  #freeName(accountId, parentId, name, exceptId = null) {
    if (!this.#nameTaken(accountId, parentId, nameKey(name), exceptId)) return name;
    for (let n = 1; n < 10000; n++) {
      const cand = numberedName(name, n);
      if (!this.#nameTaken(accountId, parentId, nameKey(cand), exceptId)) return cand;
    }
    throw E.nameConflict(name);
  }

  breadcrumb(accountId, folderId) {
    const path = [];
    let id = folderId;
    for (let i = 0; id && i < MAX_DEPTH; i++) {
      const f = this.db.get('SELECT id, name, parent_id FROM folders WHERE id = ? AND account_id = ?', id, accountId);
      if (!f) break;
      path.unshift({ id: f.id, name: f.name });
      id = f.parent_id;
    }
    return path;
  }

  #depth(accountId, folderId) { return this.breadcrumb(accountId, folderId).length; }

  createFolder(accountId, { name, parentId, conflict = 'fail' }) {
    const clean = normalizeName(name);
    return this.db.tx(() => {
      const parent = this.#parentId(accountId, parentId);
      if (parent && this.#depth(accountId, parent) >= MAX_DEPTH - 1) throw E.invalid('Demasiados niveles de carpetas.');
      let final = clean;
      if (this.#nameTaken(accountId, parent, nameKey(clean))) {
        if (conflict !== 'rename') throw E.nameConflict(clean);
        final = this.#freeName(accountId, parent, clean);
      }
      const id = newId('fld');
      const t = this.now();
      this.db.run(`INSERT INTO folders (id, account_id, parent_id, name, name_key, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?)`, id, accountId, parent, final, nameKey(final), t, t);
      return this.folderView(this.db.get('SELECT * FROM folders WHERE id = ?', id));
    });
  }

  getFolder(accountId, id) {
    const f = this.#liveFolder(accountId, id);
    if (!f) return { id: 'root', name: 'Flex Cloud', parentId: null, path: [] };
    return { ...this.folderView(f), path: this.breadcrumb(accountId, f.id) };
  }

  updateFolder(accountId, id, { name, parentId }) {
    return this.db.tx(() => {
      const f = this.#liveFolder(accountId, id);
      if (!f) throw E.invalid('La carpeta raiz no se puede cambiar.');
      let parent = f.parent_id;
      if (parentId !== undefined) {
        parent = this.#parentId(accountId, parentId);
        // Mover una carpeta dentro de si misma (o de un descendiente) la
        // dejaria colgada de un ciclo.
        for (let p = parent, i = 0; p && i < MAX_DEPTH; i++) {
          if (p === f.id) throw E.folderCycle();
          p = this.db.get('SELECT parent_id FROM folders WHERE id = ?', p)?.parent_id;
        }
      }
      const newName = name !== undefined ? normalizeName(name) : f.name;
      if (this.#nameTaken(accountId, parent, nameKey(newName), f.id)) throw E.nameConflict(newName);
      this.db.run('UPDATE folders SET name = ?, name_key = ?, parent_id = ?, updated_at = ? WHERE id = ?',
        newName, nameKey(newName), parent, this.now(), f.id);
      return this.folderView(this.db.get('SELECT * FROM folders WHERE id = ?', f.id));
    });
  }

  folderView(f) {
    return {
      type: 'folder', id: f.id, name: f.name, parentId: f.parent_id, createdAt: f.created_at, updatedAt: f.updated_at,
      ...(f.deleted_at ? { deletedAt: f.deleted_at } : {}),
    };
  }

  fileView(f) {
    return {
      type: 'file', id: f.id, name: f.name, parentId: f.parent_id, size: f.size, mime: f.mime, kind: f.kind,
      sha256: f.sha256, version: f.version, status: f.status, storageLocation: f.storage_location, source: f.source,
      hasThumbnail: !!f.thumb_key, metadata: f.metadata ? JSON.parse(f.metadata) : null,
      createdAt: f.created_at, updatedAt: f.updated_at, ...(f.deleted_at ? { deletedAt: f.deleted_at } : {}),
    };
  }

  // --------------------------------------------------------------- listados
  list(accountId, q = {}) {
    const limit = Math.min(PAGE_MAX, Math.max(1, Number.parseInt(q.limit, 10) || 100));
    const offset = decodeCursor(q.cursor);
    const view = q.view || 'folder';
    const dir = (q.order || '').toLowerCase() === 'desc' ? 'DESC' : 'ASC';
    const sortCol = { name: 'name_key', date: 'updated_at', size: 'size', type: 'kind' }[q.sort] || null;
    const kinds = ['photo', 'video', 'audio', 'document', 'archive', 'other'];
    const kind = kinds.includes(q.kind) ? q.kind : null;
    let rows;
    let folder = null;

    if (view === 'trash') {
      rows = this.db.all(`
        SELECT 'folder' AS t, id, name, name_key, 0 AS size, 'folder' AS kind, deleted_at AS updated_at, deleted_at FROM folders
          WHERE account_id = ? AND deleted_at IS NOT NULL AND trash_root = 1
        UNION ALL
        SELECT 'file' AS t, id, name, name_key, size, kind, deleted_at AS updated_at, deleted_at FROM files
          WHERE account_id = ? AND deleted_at IS NOT NULL AND trash_root = 1
        ORDER BY deleted_at DESC, id LIMIT ? OFFSET ?`, accountId, accountId, limit + 1, offset);
    } else if (view === 'recent') {
      rows = this.db.all(`SELECT 'file' AS t, * FROM files WHERE account_id = ? AND deleted_at IS NULL
                          ${kind ? 'AND kind = ?' : ''} ORDER BY updated_at DESC, id LIMIT ? OFFSET ?`,
        ...(kind ? [accountId, kind, limit + 1, offset] : [accountId, limit + 1, offset]));
    } else if (view === 'search') {
      const term = String(q.q || '').normalize('NFC').toLocaleLowerCase('und').trim().slice(0, 100);
      if (!term) return { items: [], nextCursor: null, folder: null };
      const like = '%' + term.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
      rows = this.db.all(`
        SELECT 'folder' AS t, id, name, name_key, 0 AS size, 'folder' AS kind, updated_at FROM folders
          WHERE account_id = ? AND deleted_at IS NULL AND name_key LIKE ? ESCAPE '\\'
        UNION ALL
        SELECT 'file' AS t, id, name, name_key, size, kind, updated_at FROM files
          WHERE account_id = ? AND deleted_at IS NULL AND name_key LIKE ? ESCAPE '\\' ${kind ? 'AND kind = ?' : ''}
        ORDER BY t DESC, ${sortCol || 'name_key'} ${dir}, id LIMIT ? OFFSET ?`,
        ...[accountId, like, accountId, like, ...(kind ? [kind] : []), limit + 1, offset]);
    } else {
      const parent = this.#parentId(accountId, q.parentId);
      folder = this.getFolder(accountId, parent ?? 'root');
      const p = parent ?? ROOT;
      const order = sortCol ? `${sortCol} ${dir}` : `name_key ${dir}`;
      rows = this.db.all(`
        SELECT 'folder' AS t, id, name, name_key, 0 AS size, 'folder' AS kind, updated_at FROM folders
          WHERE account_id = ? AND IFNULL(parent_id, '') = ? AND deleted_at IS NULL ${kind ? 'AND 0' : ''}
        UNION ALL
        SELECT 'file' AS t, id, name, name_key, size, kind, updated_at FROM files
          WHERE account_id = ? AND IFNULL(parent_id, '') = ? AND deleted_at IS NULL ${kind ? 'AND kind = ?' : ''}
        ORDER BY t DESC, ${order}, id LIMIT ? OFFSET ?`,
        ...[accountId, p, accountId, p, ...(kind ? [kind] : []), limit + 1, offset]);
    }

    const more = rows.length > limit;
    rows = rows.slice(0, limit);
    const items = rows.map((r) => {
      if (r.t === 'folder') {
        const f = this.db.get('SELECT * FROM folders WHERE id = ?', r.id);
        const v = this.folderView(f);
        if (view === 'trash') v.itemCount = this.db.get('SELECT COUNT(*) AS n FROM files WHERE trash_batch = ?', f.trash_batch).n;
        return v;
      }
      return this.fileView(this.db.get('SELECT * FROM files WHERE id = ?', r.id));
    });
    return { items, nextCursor: more ? encodeCursor(offset + limit) : null, folder };
  }

  #file(accountId, id, { live = true } = {}) {
    if (!ID_RE.file.test(String(id))) throw E.notFound('El archivo');
    const f = this.db.get(`SELECT * FROM files WHERE id = ? AND account_id = ? ${live ? 'AND deleted_at IS NULL' : ''}`, id, accountId);
    if (!f) throw E.notFound('El archivo');
    return f;
  }

  getFile(accountId, id) {
    const f = this.#file(accountId, id, { live: false });
    return { ...this.fileView(f), path: this.breadcrumb(accountId, f.parent_id) };
  }

  fileForDownload(accountId, id) { return this.#file(accountId, id); }

  updateFile(accountId, id, { name, parentId }) {
    return this.db.tx(() => {
      const f = this.#file(accountId, id);
      const parent = parentId !== undefined ? this.#parentId(accountId, parentId) : f.parent_id;
      const newName = name !== undefined ? normalizeName(name) : f.name;
      if (this.#nameTaken(accountId, parent, nameKey(newName), f.id)) throw E.nameConflict(newName);
      this.db.run('UPDATE files SET name = ?, name_key = ?, parent_id = ?, updated_at = ? WHERE id = ?',
        newName, nameKey(newName), parent, this.now(), f.id);
      return this.fileView(this.db.get('SELECT * FROM files WHERE id = ?', f.id));
    });
  }

  // --------------------------------------------------------------- papelera
  // Mandar a la papelera NO libera cuota (el archivo sigue guardado y se puede
  // restaurar). Solo el borrado definitivo la libera.
  trash(accountId, type, id) {
    return this.db.tx(() => {
      const t = this.now();
      const batch = newId('trb');
      if (type === 'file') {
        const f = this.#file(accountId, id);
        this.db.run('UPDATE files SET deleted_at = ?, trash_root = 1, trash_batch = ? WHERE id = ?', t, batch, f.id);
        return { batch, files: 1, folders: 0 };
      }
      const root = this.#liveFolder(accountId, id);
      if (!root) throw E.invalid('La carpeta raiz no se puede borrar.');
      const ids = this.db.all(`WITH RECURSIVE sub(id) AS (
          SELECT ? UNION ALL SELECT f.id FROM folders f JOIN sub ON f.parent_id = sub.id WHERE f.deleted_at IS NULL)
        SELECT id FROM sub`, root.id).map((r) => r.id);
      let files = 0;
      for (const fid of ids) {
        this.db.run('UPDATE folders SET deleted_at = ?, trash_root = ?, trash_batch = ? WHERE id = ?', t, fid === root.id ? 1 : 0, batch, fid);
        files += this.db.run('UPDATE files SET deleted_at = ?, trash_root = 0, trash_batch = ? WHERE parent_id = ? AND deleted_at IS NULL',
          t, batch, fid).changes;
      }
      return { batch, files, folders: ids.length };
    });
  }

  #trashRoot(accountId, type, id) {
    const table = type === 'file' ? 'files' : 'folders';
    const re = type === 'file' ? ID_RE.file : ID_RE.folder;
    if (!re.test(String(id))) throw E.notFound(type === 'file' ? 'El archivo' : 'La carpeta');
    const row = this.db.get(`SELECT * FROM ${table} WHERE id = ? AND account_id = ?`, id, accountId);
    if (!row) throw E.notFound(type === 'file' ? 'El archivo' : 'La carpeta');
    return row;
  }

  restore(accountId, type, id) {
    return this.db.tx(() => {
      const row = this.#trashRoot(accountId, type, id);
      if (!row.deleted_at) return { restored: 0, item: type === 'file' ? this.fileView(row) : this.folderView(row) };
      if (!row.trash_root) throw E.invalid('Este elemento se borro junto con su carpeta: restaura la carpeta.');
      const table = type === 'file' ? 'files' : 'folders';
      // Si la carpeta de origen ya no existe (o sigue en la papelera), vuelve a
      // la raiz. Si el nombre esta ocupado, se renombra: nunca se pisa nada.
      let parent = row.parent_id;
      if (parent && !this.db.get('SELECT id FROM folders WHERE id = ? AND account_id = ? AND deleted_at IS NULL', parent, accountId)) parent = null;
      const name = this.#freeName(accountId, parent, row.name);
      const batch = row.trash_batch;
      this.db.run(`UPDATE ${table} SET deleted_at = NULL, trash_root = 0, trash_batch = NULL, parent_id = ?, name = ?, name_key = ?, updated_at = ? WHERE id = ?`,
        parent, name, nameKey(name), this.now(), row.id);
      let restored = 1;
      if (batch) {
        restored += this.db.run('UPDATE folders SET deleted_at = NULL, trash_batch = NULL WHERE trash_batch = ? AND account_id = ?', batch, accountId).changes;
        restored += this.db.run('UPDATE files SET deleted_at = NULL, trash_batch = NULL WHERE trash_batch = ? AND account_id = ?', batch, accountId).changes;
      }
      const item = this.db.get(`SELECT * FROM ${table} WHERE id = ?`, row.id);
      return { restored, item: type === 'file' ? this.fileView(item) : this.folderView(item) };
    });
  }

  // Borrado DEFINITIVO: filas fuera y cuota liberada en una transaccion; los
  // bytes se borran del disco despues (si eso fallara, el barrido de objetos
  // huerfanos los recoge: nunca queda cuota cobrada por algo que no existe).
  async permanentDelete(accountId, type, id) {
    const removed = this.db.tx(() => {
      let row = this.#trashRoot(accountId, type, id);
      if (!row.deleted_at) { this.trash(accountId, type, id); row = this.#trashRoot(accountId, type, id); }
      if (!row.trash_root) throw E.invalid('Este elemento se borro junto con su carpeta: borra la carpeta.');
      return this.#purgeBatch(accountId, row.trash_batch);
    });
    await this.#removeObjects(removed.keys);
    return { files: removed.files, folders: removed.folders, freedBytes: removed.bytes };
  }

  #purgeBatch(accountId, batch) {
    const files = this.db.all('SELECT id, size, storage_key, thumb_key FROM files WHERE account_id = ? AND trash_batch = ?', accountId, batch);
    const bytes = files.reduce((s, f) => s + f.size, 0);
    this.db.run('DELETE FROM files WHERE account_id = ? AND trash_batch = ?', accountId, batch);
    // Hijas antes que madres (clave foranea): por profundidad descendente.
    const folders = this.db.all('SELECT id FROM folders WHERE account_id = ? AND trash_batch = ?', accountId, batch).map((r) => r.id);
    const depth = new Map(folders.map((fid) => [fid, this.#depth(accountId, fid)]));
    folders.sort((a, b) => depth.get(b) - depth.get(a));
    for (const fid of folders) {
      // Lo que se mando a la papelera POR SEPARADO antes que la carpeta
      // (otro lote) pierde su carpeta: se queda en la papelera, en la raiz.
      this.db.run('UPDATE files SET parent_id = NULL WHERE parent_id = ?', fid);
      this.db.run('UPDATE folders SET parent_id = NULL WHERE parent_id = ?', fid);
      this.db.run('DELETE FROM folders WHERE id = ?', fid);
    }
    this.db.run('UPDATE accounts SET used_bytes = used_bytes - ?, updated_at = ? WHERE id = ?', bytes, this.now(), accountId);
    return { files: files.length, folders: folders.length, bytes, keys: files.flatMap((f) => [f.storage_key, f.thumb_key].filter(Boolean)) };
  }

  async #removeObjects(keys) {
    for (const k of keys) await this.store.remove(k).catch((e) => this.log('warn', 'no se pudo borrar un objeto', { key: k, err: e.message }));
  }

  async emptyTrash(accountId) {
    const batches = this.db.all(`SELECT DISTINCT trash_batch AS b FROM (
        SELECT trash_batch FROM files WHERE account_id = ? AND deleted_at IS NOT NULL AND trash_root = 1
        UNION ALL SELECT trash_batch FROM folders WHERE account_id = ? AND deleted_at IS NOT NULL AND trash_root = 1)`,
      accountId, accountId).map((r) => r.b);
    let freed = 0, files = 0;
    for (const b of batches) {
      const r = this.db.tx(() => this.#purgeBatch(accountId, b));
      freed += r.bytes; files += r.files;
      await this.#removeObjects(r.keys);
    }
    return { files, freedBytes: freed };
  }

  // ------------------------------------------------------------- miniaturas
  // La miniatura es un objeto APARTE: el original nunca se toca.
  async setThumbnail(accountId, id, buffer, mime) {
    if (!/^image\/(jpeg|png|webp)$/.test(mime)) throw E.invalid('La miniatura debe ser JPEG, PNG o WebP.');
    if (!buffer.length || buffer.length > this.cfg.thumbMaxBytes) throw E.payloadTooLarge();
    const okMagic = (mime === 'image/jpeg' && buffer[0] === 0xff && buffer[1] === 0xd8)
      || (mime === 'image/png' && buffer.subarray(0, 4).toString('latin1') === '\x89PNG')
      || (mime === 'image/webp' && buffer.subarray(0, 4).toString('latin1') === 'RIFF' && buffer.subarray(8, 12).toString('latin1') === 'WEBP');
    if (!okMagic) throw E.invalid('La miniatura no es una imagen valida.');
    const f = this.#file(accountId, id);
    const key = newStorageKey();
    await this.store.putSmall(key, buffer);
    const old = this.db.tx(() => {
      const cur = this.#file(accountId, id);
      this.db.run('UPDATE files SET thumb_key = ?, thumb_mime = ?, thumb_size = ? WHERE id = ?', key, mime, buffer.length, cur.id);
      return cur.thumb_key;
    });
    if (old) await this.store.remove(old).catch(() => {});
    return { id: f.id, hasThumbnail: true };
  }

  thumbnail(accountId, id) {
    const f = this.#file(accountId, id, { live: false });
    if (!f.thumb_key) throw E.notFound('La miniatura');
    return f;
  }

  // ---------------------------------------------------------------- subidas
  #upload(accountId, id) {
    if (!ID_RE.upload.test(String(id))) throw E.uploadNotFound();
    const u = this.db.get('SELECT * FROM uploads WHERE id = ? AND account_id = ?', id, accountId);
    if (!u) throw E.uploadNotFound();
    return u;
  }

  createUpload(accountId, body, source = 'web') {
    const name = normalizeName(body.name);
    const size = body.size;
    if (!Number.isSafeInteger(size) || size < 0) throw E.invalid('El tamano del archivo no es valido.');
    if (size > this.cfg.maxFileBytes) throw E.fileTooLarge(this.cfg.maxFileBytes);
    const sha = body.sha256 === undefined || body.sha256 === null ? null : String(body.sha256).toLowerCase();
    if (sha !== null && !isHex64(sha)) throw E.invalid('sha256 debe ser hexadecimal de 64 caracteres.');
    const clientKey = typeof body.clientKey === 'string' && /^[A-Za-z0-9_.:/@+=-]{8,200}$/.test(body.clientKey) ? body.clientKey : null;
    const conflict = body.conflict === 'fail' ? 'fail' : 'rename';
    let chunk = Number.isSafeInteger(body.chunkSize) ? body.chunkSize : this.cfg.chunkDefault;
    chunk = Math.min(this.cfg.chunkMax, Math.max(this.cfg.chunkMin, chunk));
    while (size > 0 && Math.ceil(size / chunk) > this.cfg.maxParts && chunk < this.cfg.chunkMax) chunk = Math.min(this.cfg.chunkMax, chunk * 2);
    const totalParts = size === 0 ? 0 : Math.ceil(size / chunk);
    if (totalParts > this.cfg.maxParts) throw E.fileTooLarge(this.cfg.chunkMax * this.cfg.maxParts);
    const mime = mimeFor(name, body.mimeType);
    const meta = cleanMeta(body.metadata);

    return this.db.tx(() => {
      const parent = this.#parentId(accountId, body.parentId);
      const t = this.now();
      // REANUDAR: la misma subida (misma clave del cliente, mismo nombre,
      // tamano y carpeta) devuelve la sesion que ya existia con sus partes.
      if (clientKey) {
        const prev = this.db.get(`SELECT * FROM uploads WHERE account_id = ? AND client_key = ? AND state = 'active'
                                  AND size = ? AND name = ? AND IFNULL(parent_id, '') = ? ORDER BY created_at DESC LIMIT 1`,
          accountId, clientKey, size, name, parent ?? ROOT);
        if (prev && prev.expires_at > t) {
          this.db.run('UPDATE uploads SET expires_at = ?, updated_at = ? WHERE id = ?', t + this.cfg.uploadTtlMs, t, prev.id);
          return { ...this.uploadView(this.db.get('SELECT * FROM uploads WHERE id = ?', prev.id)), resumed: true };
        }
      }
      if (conflict === 'fail' && this.#nameTaken(accountId, parent, nameKey(name))) throw E.nameConflict(name);
      // RESERVA ATOMICA: usado + reservado + este archivo <= cuota. Dentro de
      // la transaccion, dos subidas simultaneas no pueden ver el mismo hueco.
      const acc = this.db.get('SELECT * FROM accounts WHERE id = ?', accountId);
      const total = this.totalFor(acc);
      const available = total - acc.used_bytes - acc.reserved_bytes;
      if (size > available) throw E.quotaExceeded(size, Math.max(0, available));
      this.db.run('UPDATE accounts SET reserved_bytes = reserved_bytes + ?, updated_at = ? WHERE id = ?', size, t, accountId);
      const id = newId('upl');
      this.db.run(`INSERT INTO uploads (id, account_id, parent_id, name, mime, size, chunk_size, total_parts, sha256, client_key,
                     state, reserved_bytes, storage_key, source, metadata, created_at, updated_at, expires_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)`,
        id, accountId, parent, name, mime, size, chunk, totalParts, sha, clientKey, size, newStorageKey(), source,
        meta ? JSON.stringify(meta) : null, t, t, t + this.cfg.uploadTtlMs);
      this.log('info', 'subida creada', { upload: id, size, parts: totalParts, source });
      return { ...this.uploadView(this.db.get('SELECT * FROM uploads WHERE id = ?', id)), resumed: false };
    });
  }

  uploadView(u) {
    const parts = this.db.all('SELECT part_number FROM upload_parts WHERE upload_id = ? ORDER BY part_number', u.id).map((r) => r.part_number);
    const v = {
      uploadId: u.id, name: u.name, size: u.size, mime: u.mime, parentId: u.parent_id, chunkSize: u.chunk_size,
      totalParts: u.total_parts, receivedParts: parts, receivedBytes: u.received_bytes, sha256: u.sha256,
      state: u.state, createdAt: u.created_at, updatedAt: u.updated_at, expiresAt: u.expires_at,
    };
    if (u.file_id) {
      v.fileId = u.file_id;
      const f = this.db.get('SELECT * FROM files WHERE id = ?', u.file_id);
      if (f) v.file = this.fileView(f);
    }
    if (u.error) v.error = u.error;
    return v;
  }

  uploadStatus(accountId, id) {
    const u = this.#upload(accountId, id);
    if (u.state === 'active' && u.expires_at <= this.now()) { this.#expire(u); return this.uploadView(this.#upload(accountId, id)); }
    return this.uploadView(u);
  }

  listUploads(accountId) {
    return this.db.all(`SELECT * FROM uploads WHERE account_id = ? AND state IN ('active', 'completing') AND expires_at > ?
                        ORDER BY updated_at DESC LIMIT 50`, accountId, this.now()).map((u) => this.uploadView(u));
  }

  expectedPartSize(u, n) {
    if (n < u.total_parts) return u.chunk_size;
    return u.size - (u.total_parts - 1) * u.chunk_size;
  }

  #activeUpload(accountId, id) {
    const u = this.#upload(accountId, id);
    if (u.state !== 'active') {
      if (u.state === 'expired') throw E.uploadExpired();
      throw E.uploadState(u.state);
    }
    if (u.expires_at <= this.now()) { this.#expire(u); throw E.uploadExpired(); }
    return u;
  }

  // Recibe la parte `n` (1..totalParts). Idempotente: repetir una parte ya
  // recibida con el MISMO contenido no la vuelve a escribir. Si la cabecera ya
  // dice que es la misma, ni siquiera se leen los bytes.
  async receivePart(accountId, id, n, source, declaredSha) {
    const u = this.#activeUpload(accountId, id);
    if (!Number.isSafeInteger(n) || n < 1 || n > u.total_parts) throw E.partRange(u.total_parts);
    if (!isHex64(declaredSha)) throw E.invalid('Falta el SHA-256 de la parte (cabecera X-Part-SHA256 o Content-Digest).');
    const expected = this.expectedPartSize(u, n);
    const prev = this.db.get('SELECT * FROM upload_parts WHERE upload_id = ? AND part_number = ?', u.id, n);
    if (prev) {
      if (prev.sha256 === declaredSha) return { part: n, size: prev.size, sha256: prev.sha256, alreadyReceived: true, ...this.#progress(u.id) };
      throw E.partConflict();
    }
    // Una parte puede estar llegando por DOS conexiones a la vez: la de antes
    // de un corte de Wi-Fi (que el servidor aun no sabe que esta muerta) y la
    // del reintento. Las dos escriben en temporales distintos y nadie espera a
    // nadie; solo la CONFIRMACION (renombrar + anotar) va en exclusiva, y gana
    // la primera que llega completa y verificada.
    const got = await this.store.receivePart(u.id, n, source, expected);
    if (got.size !== expected) { await this.store.discard(got.tmp); throw E.partSize(expected, got.size); }
    if (got.sha256 !== declaredSha) {
      await this.store.discard(got.tmp);
      this.log('warn', 'parte con checksum incorrecto', { upload: u.id, part: n });
      throw E.checksum(declaredSha, got.sha256);
    }
    return this.#commitLocked(`${u.id}:${n}`, async () => {
      // La subida pudo abortarse o caducar mientras llegaban los bytes.
      const cur = this.db.get('SELECT state FROM uploads WHERE id = ?', u.id);
      if (!cur || cur.state !== 'active') { await this.store.discard(got.tmp); throw E.uploadState(cur?.state || 'gone'); }
      const won = this.db.get('SELECT * FROM upload_parts WHERE upload_id = ? AND part_number = ?', u.id, n);
      if (won) {
        await this.store.discard(got.tmp);
        if (won.sha256 !== got.sha256) throw E.partConflict();
        return { part: n, size: won.size, sha256: won.sha256, alreadyReceived: true, ...this.#progress(u.id) };
      }
      await this.store.commitPart(got.tmp, u.id, n);
      this.db.tx(() => {
        const t = this.now();
        this.db.run('INSERT INTO upload_parts (upload_id, part_number, size, sha256, received_at) VALUES (?, ?, ?, ?, ?)', u.id, n, got.size, got.sha256, t);
        this.db.run('UPDATE uploads SET received_bytes = received_bytes + ?, updated_at = ?, expires_at = ? WHERE id = ?',
          got.size, t, t + this.cfg.uploadTtlMs, u.id);
      });
      return { part: n, size: got.size, sha256: got.sha256, alreadyReceived: false, ...this.#progress(u.id) };
    });
  }

  // Cerrojo asincrono por clave: encadena las secciones criticas.
  async #commitLocked(key, fn) {
    const prev = this.partLocks.get(key) || Promise.resolve();
    let release;
    const mine = new Promise((r) => { release = r; });
    const chain = prev.then(() => mine);
    this.partLocks.set(key, chain);
    await prev;
    try { return await fn(); } finally {
      release();
      if (this.partLocks.get(key) === chain) this.partLocks.delete(key);
    }
  }

  #progress(uploadId) {
    const r = this.db.get('SELECT received_bytes, total_parts, (SELECT COUNT(*) FROM upload_parts WHERE upload_id = uploads.id) AS n FROM uploads WHERE id = ?', uploadId);
    return { receivedBytes: r.received_bytes, receivedCount: r.n, totalParts: r.total_parts };
  }

  async completeUpload(accountId, id, body = {}) {
    const u0 = this.#upload(accountId, id);
    if (u0.state === 'completed') return this.uploadView(u0);                       // idempotente
    if (u0.state === 'completing' || this.completing.has(u0.id)) throw E.uploadState('completing');
    const u = this.#activeUpload(accountId, id);
    const declared = body.sha256 !== undefined && body.sha256 !== null ? String(body.sha256).toLowerCase() : u.sha256;
    if (declared !== null && declared !== undefined && !isHex64(declared)) throw E.invalid('sha256 debe ser hexadecimal de 64 caracteres.');
    if (u.sha256 && declared && declared !== u.sha256) throw E.invalid('El sha256 no coincide con el declarado al crear la subida.');
    const have = this.db.all('SELECT part_number FROM upload_parts WHERE upload_id = ?', u.id).map((r) => r.part_number);
    if (have.length !== u.total_parts || u.received_bytes !== u.size) {
      const set = new Set(have);
      const missing = [];
      for (let n = 1; n <= u.total_parts && missing.length < 100; n++) if (!set.has(n)) missing.push(n);
      throw E.incomplete(missing);
    }
    this.completing.add(u.id);
    this.db.run(`UPDATE uploads SET state = 'completing', updated_at = ? WHERE id = ?`, this.now(), u.id);
    let assembled;
    try {
      assembled = await this.store.assemble(u.id, u.total_parts, u.storage_key);
      if (assembled.size !== u.size) throw new Error(`tamano ensamblado ${assembled.size} != ${u.size}`);
      if (declared && assembled.sha256 !== declared) {
        await this.store.discard(assembled.tmp);
        // Cada parte llego verificada: si el total no cuadra, el archivo del
        // cliente cambio entre partes. Se descarta entera y se libera la reserva.
        this.db.tx(() => {
          this.db.run(`UPDATE uploads SET state = 'failed', error = 'checksum_mismatch', updated_at = ? WHERE id = ?`, this.now(), u.id);
          this.db.run('UPDATE accounts SET reserved_bytes = reserved_bytes - ? WHERE id = ?', u.reserved_bytes, accountId);
        });
        await this.store.removeUpload(u.id);
        this.log('warn', 'subida descartada: SHA-256 del archivo no coincide', { upload: u.id });
        throw E.checksum(declared, assembled.sha256);
      }
      await this.store.publish(assembled.tmp, u.storage_key);
    } catch (e) {
      if (!(e instanceof CloudError)) {
        // Fallo de disco a mitad: la subida vuelve a 'active' con sus partes
        // intactas; completar se puede reintentar.
        if (assembled?.tmp) await this.store.discard(assembled.tmp);
        this.db.run(`UPDATE uploads SET state = 'active', updated_at = ? WHERE id = ? AND state = 'completing'`, this.now(), u.id);
        this.log('error', 'fallo al ensamblar', { upload: u.id, err: e.message });
      }
      this.completing.delete(u.id);
      throw e;
    }
    let fileId;
    try {
      fileId = this.db.tx(() => {
        const t = this.now();
        // La carpeta pudo borrarse mientras se subia: entonces va a la raiz.
        let parent = u.parent_id;
        if (parent && !this.db.get('SELECT id FROM folders WHERE id = ? AND account_id = ? AND deleted_at IS NULL', parent, accountId)) parent = null;
        const name = this.#freeName(accountId, parent, u.name);
        const fid = newId('fil');
        this.db.run(`INSERT INTO files (id, account_id, parent_id, name, name_key, storage_key, size, mime, kind, sha256, source, metadata, created_at, updated_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          fid, accountId, parent, name, nameKey(name), u.storage_key, u.size, u.mime, kindFor(u.mime), assembled.sha256, u.source, u.metadata, t, t);
        this.db.run(`UPDATE accounts SET reserved_bytes = reserved_bytes - ?, used_bytes = used_bytes + ?, updated_at = ? WHERE id = ?`,
          u.reserved_bytes, u.size, t, accountId);
        this.db.run(`UPDATE uploads SET state = 'completed', file_id = ?, updated_at = ? WHERE id = ?`, fid, t, u.id);
        return fid;
      });
    } catch (e) {
      await this.store.remove(u.storage_key).catch(() => {});
      this.db.run(`UPDATE uploads SET state = 'active', updated_at = ? WHERE id = ? AND state = 'completing'`, this.now(), u.id);
      throw e;
    } finally {
      this.completing.delete(u.id);
    }
    await this.store.removeUpload(u.id).catch(() => {});
    this.log('info', 'subida completada', { upload: u.id, file: fileId, size: u.size });
    return this.uploadView(this.db.get('SELECT * FROM uploads WHERE id = ?', u.id));
  }

  async abortUpload(accountId, id) {
    const u = this.#upload(accountId, id);
    if (u.state === 'completing') throw E.uploadState('completing');
    if (u.state === 'active') {
      this.db.tx(() => {
        this.db.run(`UPDATE uploads SET state = 'aborted', updated_at = ? WHERE id = ?`, this.now(), u.id);
        this.db.run('UPDATE accounts SET reserved_bytes = reserved_bytes - ? WHERE id = ?', u.reserved_bytes, accountId);
      });
      await this.store.removeUpload(u.id);
      this.log('info', 'subida cancelada', { upload: u.id });
    }
    return this.uploadView(this.db.get('SELECT * FROM uploads WHERE id = ?', u.id));
  }

  #expire(u) {
    const changed = this.db.tx(() => {
      const r = this.db.run(`UPDATE uploads SET state = 'expired', updated_at = ? WHERE id = ? AND state = 'active'`, this.now(), u.id);
      if (r.changes) this.db.run('UPDATE accounts SET reserved_bytes = reserved_bytes - ? WHERE id = ?', u.reserved_bytes, u.account_id);
      return r.changes;
    });
    if (changed) this.store.removeUpload(u.id).catch(() => {});
  }

  // ------------------------------------------------------- enlaces firmados
  // URL temporal para un archivo concreto (reproductor de video, compartir con
  // otro dispositivo propio). Firmada con HMAC del servidor; no contiene ni
  // revela credenciales del almacen.
  signLink(accountId, id) {
    const f = this.#file(accountId, id);
    const exp = this.now() + this.cfg.signedUrlTtlMs;
    const payload = Buffer.from(JSON.stringify({ f: f.id, a: accountId, v: f.version, e: exp })).toString('base64url');
    const sig = createHmac('sha256', this.cfg.secret).update(payload).digest('base64url');
    return { token: `${payload}.${sig}`, expiresAt: exp };
  }

  verifyLink(token) {
    const [payload, sig] = String(token || '').split('.');
    if (!payload || !sig) throw E.linkInvalid();
    const expect = createHmac('sha256', this.cfg.secret).update(payload).digest();
    const got = Buffer.from(sig, 'base64url');
    if (got.length !== expect.length || !timingSafeEqual(got, expect)) throw E.linkInvalid();
    let d;
    try { d = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { throw E.linkInvalid(); }
    if (!d || typeof d.e !== 'number' || d.e < this.now()) throw E.linkInvalid();
    const f = this.db.get('SELECT * FROM files WHERE id = ? AND account_id = ? AND deleted_at IS NULL', d.f, d.a);
    if (!f || f.version !== d.v) throw E.linkInvalid();
    return f;
  }

  // ------------------------------------------------------------ mantenimiento
  expireUploads() {
    const rows = this.db.all(`SELECT * FROM uploads WHERE state = 'active' AND expires_at <= ?`, this.now());
    for (const u of rows) this.#expire(u);
    return rows.length;
  }

  async purgeTrash() {
    const limit = this.now() - this.cfg.trashRetentionMs;
    const roots = this.db.all(`SELECT account_id, trash_batch FROM files WHERE deleted_at IS NOT NULL AND trash_root = 1 AND deleted_at <= ?
                               UNION SELECT account_id, trash_batch FROM folders WHERE deleted_at IS NOT NULL AND trash_root = 1 AND deleted_at <= ?`, limit, limit);
    let n = 0;
    for (const r of roots) {
      const res = this.db.tx(() => this.#purgeBatch(r.account_id, r.trash_batch));
      await this.#removeObjects(res.keys);
      n += res.files;
    }
    return n;
  }

  // Al arrancar: lo que quedo a medias por un corte se deja coherente.
  async recover() {
    await this.store.sweepTemp();
    const stuck = this.db.run(`UPDATE uploads SET state = 'active' WHERE state = 'completing'`).changes;
    const keep = new Set(this.db.all(`SELECT id FROM uploads WHERE state = 'active'`).map((r) => r.id));
    for (const d of await this.store.listUploadDirs()) {
      if (!keep.has(d)) await this.store.removeUpload(d);
      else await this.store.sweepPartTemps(d);
    }
    // Partes anotadas cuyo fichero no existe (disco restaurado de una copia):
    // se olvidan para que el cliente las vuelva a mandar.
    for (const id of keep) {
      const parts = this.db.all('SELECT part_number, size FROM upload_parts WHERE upload_id = ?', id);
      for (const p of parts) {
        const sz = await stat(this.store.partPath(id, p.part_number)).then((s) => s.size).catch(() => -1);
        if (sz !== p.size) {
          this.db.tx(() => {
            this.db.run('DELETE FROM upload_parts WHERE upload_id = ? AND part_number = ?', id, p.part_number);
            this.db.run('UPDATE uploads SET received_bytes = received_bytes - ? WHERE id = ?', p.size, id);
          });
        }
      }
    }
    const fixed = this.reconcileQuotas();
    return { stuck, fixed };
  }

  // La cuota se recalcula desde las tablas: si algun contador se hubiera
  // desviado (corte entre dos escrituras), se corrige solo.
  reconcileQuotas() {
    return this.db.tx(() => {
      let fixed = 0;
      for (const a of this.db.all('SELECT id, used_bytes, reserved_bytes FROM accounts')) {
        const used = this.db.get('SELECT IFNULL(SUM(size), 0) AS s FROM files WHERE account_id = ?', a.id).s;
        const reserved = this.db.get(`SELECT IFNULL(SUM(reserved_bytes), 0) AS s FROM uploads WHERE account_id = ? AND state IN ('active', 'completing')`, a.id).s;
        if (used !== a.used_bytes || reserved !== a.reserved_bytes) {
          this.db.run('UPDATE accounts SET used_bytes = ?, reserved_bytes = ? WHERE id = ?', used, reserved, a.id);
          fixed++;
        }
      }
      return fixed;
    });
  }
}
