// Cliente de la API de Flex Cloud. La sesion es la cookie de Flex Account; la
// cabecera X-Flex-Cloud demuestra que la peticion sale de esta web (CSRF).
export class ApiError extends Error {
  constructor(status, code, message, details) { super(message); this.status = status; this.code = code; this.details = details; }
  get offline() { return this.code === 'network'; }
}

const BASE = document.querySelector('meta[name="flex-cloud-api"]')?.content || '/api/cloud';

async function request(method, path, { json, body, headers = {}, signal } = {}) {
  const h = { 'x-flex-cloud': '1', accept: 'application/json', ...headers };
  let payload = body;
  if (json !== undefined) { h['content-type'] = 'application/json'; payload = JSON.stringify(json); }
  let res;
  try {
    res = await fetch(BASE + path, { method, headers: h, body: payload, credentials: 'same-origin', signal, cache: 'no-store' });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new ApiError(0, 'network', navigator.onLine === false ? 'Sin conexión a Internet.' : 'No se pudo contactar con Flex Cloud.');
  }
  let data = null;
  try { data = await res.json(); } catch { /* cuerpo no JSON */ }
  if (!res.ok || !data || data.ok !== true) {
    const err = data?.error || {};
    throw new ApiError(res.status, err.code || `http_${res.status}`, err.message || `Flex Cloud respondió ${res.status}.`, err.details);
  }
  return data;
}

const q = (o) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
};

export const api = {
  base: BASE,
  health: () => request('GET', '/health'),
  me: () => request('GET', '/me'),
  quota: () => request('GET', '/quota'),
  list: (params) => request('GET', '/files' + q(params)),
  file: (id) => request('GET', `/files/${id}`),
  folder: (id) => request('GET', `/folders/${id}`),
  createFolder: (name, parentId, conflict) => request('POST', '/folders', { json: { name, parentId, conflict } }),
  renameFile: (id, name) => request('PATCH', `/files/${id}`, { json: { name } }),
  renameFolder: (id, name) => request('PATCH', `/folders/${id}`, { json: { name } }),
  moveFile: (id, parentId) => request('PATCH', `/files/${id}`, { json: { parentId } }),
  moveFolder: (id, parentId) => request('PATCH', `/folders/${id}`, { json: { parentId } }),
  trash: (type, id) => request('DELETE', `/${type === 'folder' ? 'folders' : 'files'}/${id}`),
  restore: (type, id) => request('POST', `/${type === 'folder' ? 'folders' : 'files'}/${id}/restore`),
  destroy: (type, id) => request('POST', `/${type === 'folder' ? 'folders' : 'files'}/${id}/permanent-delete`),
  emptyTrash: () => request('POST', '/trash/empty'),
  link: (id) => request('POST', `/files/${id}/link`),
  uploads: () => request('GET', '/uploads'),
  createUpload: (body) => request('POST', '/uploads', { json: body }),
  uploadStatus: (id) => request('GET', `/uploads/${id}`),
  completeUpload: (id, body = {}) => request('POST', `/uploads/${id}/complete`, { json: body }),
  abortUpload: (id) => request('DELETE', `/uploads/${id}`),
  putThumb: (id, blob) => request('PUT', `/files/${id}/thumbnail`, { body: blob, headers: { 'content-type': blob.type } }),
  devLogin: (flexAddress, displayName) => request('POST', '/dev/login', { json: { flexAddress, displayName } }),
  devLogout: () => request('POST', '/dev/logout'),
  downloadUrl: (id, inline = false) => `${BASE}/download/${id}${inline ? '?inline=1' : ''}`,
  thumbUrl: (id) => `${BASE}/files/${id}/thumbnail`,
  partUrl: (uploadId, n) => `${BASE}/uploads/${uploadId}/parts/${n}`,
};
