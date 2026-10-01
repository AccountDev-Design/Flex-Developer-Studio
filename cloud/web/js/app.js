// Flex Cloud Web · controlador principal.
// Rutas por hash (#/, #/f/<carpeta>, #/recent, #/media, #/trash, #/search/<q>)
// para que la app funcione igual servida en / o bajo /cloud/.
import { api, ApiError } from './api.js';
import { art } from './art.js';
import { bytes, duration, escapeHtml, fullDate, initials, KIND_LABEL, kindOfMime, when } from './format.js';
import { icon, kindIcon } from './icons.js';
import { transfers } from './transfers.js';
import { $, $$, closeMenú, closeModal, confirm, h, isModalOpen, menu, pickFolder, prompt, toast } from './ui.js';

const LOGIN_URL = document.querySelector('meta[name="flex-account-login"]')?.content || '/login';
const LOGOUT_URL = document.querySelector('meta[name="flex-account-logout"]')?.content || '/logout';
const PAGE = 100;

const store = {
  get(k, d) { try { return localStorage.getItem(`flexcloud.${k}`) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`flexcloud.${k}`, v); } catch { /* privado */ } },
};

const S = {
  health: null, me: null, quota: null,
  route: { view: 'files', id: 'root', q: '' },
  items: [], folder: null, next: null, loading: false, error: null, loadSeq: 0,
  sel: new Set(), anchor: null,
  layout: store.get('layout', 'grid'), sort: store.get('sort', 'name'), order: store.get('order', 'asc'),
  theme: store.get('theme', 'auto'), xferCollapsed: false, xferHidden: false,
};

const root = $('#root');
applyTheme();

// ----------------------------------------------------------------- rutas
function parseRoute() {
  const p = location.hash.replace(/^#\/?/, '').split('/');
  if (p[0] === 'f' && p[1]) return { view: 'files', id: p[1], q: '' };
  if (p[0] === 'recent') return { view: 'recent', id: null, q: '' };
  if (p[0] === 'media') return { view: 'media', id: null, q: '' };
  if (p[0] === 'trash') return { view: 'trash', id: null, q: '' };
  if (p[0] === 'search') return { view: 'search', id: null, q: decodeURIComponent(p.slice(1).join('/')) };
  return { view: 'files', id: 'root', q: '' };
}
const go = (hash) => { if (location.hash === hash) loadView(); else location.hash = hash; };
const folderHash = (id) => (!id || id === 'root' ? '#/' : `#/f/${id}`);

// ------------------------------------------------------------- arranque
async function boot() {
  root.innerHTML = `<div class="gate"><div class="gate-card glass"><div class="skel" style="height:180px"></div><div class="skel skel-line" style="margin:18px auto 8px;width:60%"></div><div class="skel skel-line" style="width:80%;margin:auto"></div></div></div>`;
  try { S.health = (await api.health()); } catch { S.health = null; }
  try {
    const me = await api.me();
    S.me = me; S.quota = me.quota;
  } catch (e) {
    return gate(e);
  }
  shell();
  addEventListener('hashchange', () => { S.route = parseRoute(); S.sel.clear(); closeMenú(); closeDetails(); loadView(); renderNav(); closeSide(); });
  S.route = parseRoute();
  renderNav();
  loadView();
  transfers.addEventListener('change', renderTransfers);
  transfers.addEventListener('uploaded', onUploaded);
  transfers.addEventListener('thumb', (e) => refreshThumb(e.detail.fileId));
  transfers.restorePending();
  addEventListener('online', () => { renderBanner(); refreshQuota(); if (S.error) loadView(); });
  addEventListener('offline', renderBanner);
  addEventListener('beforeunload', (e) => { if (transfers.active().some((t) => t.type === 'upload' && t.file)) { e.preventDefault(); e.returnValue = ''; } });
  setupDrop();
  setupKeys();
}

// ----------------------------------------------------------- acceso
function gate(err) {
  const dev = S.health?.devLogin;
  let artHtml = art.welcome(), title = 'Tu nube Flex', text = 'Tus fotos, vídeos y archivos, en Flex Developer Studio y en tu Flex OS Ultra. Con tu Flex Account, sin otra contraseña.', actions = '';
  if (err instanceof ApiError && err.offline) {
    artHtml = art.offline(); title = 'Sin conexión'; text = 'No hay conexión con Flex Cloud. Comprueba tu red; volveremos a intentarlo al reconectar.';
    actions = `<button class="btn primary" data-retry>${icon('retry')} Reintentar</button>`;
    addEventListener('online', () => boot(), { once: true });
  } else if (err instanceof ApiError && (err.code === 'account_unavailable' || err.status >= 500)) {
    artHtml = art.error(); title = 'Flex Account no responde'; text = 'No es tu cuenta ni tus archivos: el servicio de identidad no contesta ahora mismo. Prueba en unos segundos.';
    actions = `<button class="btn primary" data-retry>${icon('retry')} Reintentar</button>`;
  } else {
    if (err?.code === 'token_expired') text = 'Tu sesión caducó. Vuelve a entrar con tu Flex Account.';
    actions = `<a class="btn primary" href="${escapeHtml(LOGIN_URL)}">${icon('shield')} Iniciar sesión con Flex Account</a>`;
  }
  root.innerHTML = `<main class="gate"><div class="gate-card glass">${artHtml}
    <h1>${title}</h1><p>${text}</p>${actions}
    ${dev && !(err instanceof ApiError && err.offline) ? `<form class="dev" data-dev><strong>Modo desarrollo</strong>
      <p style="margin:4px 0 0;font-size:13px">Este servidor usa cuentas locales de prueba (FLEX_ACCOUNT_MODE=dev). En producción se entra con Flex Account.</p>
      <input class="field" name="addr" value="usuario@flex" aria-label="Dirección @flex" pattern="[a-z0-9._\\-]{1,40}@flex" required>
      <input class="field" name="name" value="Usuario Flex" aria-label="Nombre" maxlength="60">
      <button class="btn">Entrar en modo desarrollo</button></form>` : ''}
  </div></main>`;
  $('[data-retry]', root)?.addEventListener('click', boot);
  const f = $('[data-dev]', root);
  if (f) f.onsubmit = async (e) => {
    e.preventDefault();
    try { await api.devLogin(f.addr.value.trim(), f.name.value.trim()); boot(); } catch (x) { toast(x.message, { error: true }); }
  };
}

// --------------------------------------------------------------- marco
function shell() {
  const a = S.me.account;
  root.innerHTML = `
  <div class="app">
    <aside class="side glass" aria-label="Navegación">
      <div class="brand"><div class="logo">${'<svg viewBox="0 0 24 24"><path d="M7 18h10.5a4.5 4.5 0 0 0 .4-8.98A6 6 0 0 0 6.2 8.6 4.7 4.7 0 0 0 7 18z"/></svg>'}</div>
        <div><strong>Flex Cloud</strong><span>Flex Developer Studio</span></div></div>
      <button class="btn primary" data-act="upload-menu" style="margin:0 4px 10px">${icon('upload')} Subir</button>
      <nav class="nav" data-nav>
        <a href="#/" data-v="files">${icon('cloud')} Mi nube</a>
        <a href="#/recent" data-v="recent">${icon('clock')} Recientes</a>
        <a href="#/media" data-v="media">${icon('photo')} Fotos y vídeos</a>
        <a href="#/trash" data-v="trash">${icon('trash')} Papelera</a>
      </nav>
      <div class="spacer"></div>
      <div data-quota></div>
      <div class="side-sep"></div>
      <div class="nav"><button data-act="device-info">${icon('device')} Flex OS Ultra</button></div>
    </aside>
    <section class="main">
      <header class="topbar">
        <button class="icon-btn menu-btn" data-act="side" aria-label="Menú">${icon('menu')}</button>
        <label class="search glass">${icon('search')}<span class="sr">Buscar</span>
          <input type="search" data-search placeholder="Buscar en Flex Cloud" autocomplete="off" spellcheck="false"></label>
        <div class="top-actions">
          <button class="icon-btn hide-sm" data-act="theme" aria-label="Tema">${icon(S.theme === 'light' ? 'moon' : 'sun')}</button>
          <button class="avatar" data-act="account" aria-label="Cuenta ${escapeHtml(a.flexAddress || '')}">${escapeHtml(initials(a.displayName || a.flexAddress))}</button>
        </div>
      </header>
      <div class="content" data-content><div data-banner></div><div data-view></div><div data-more style="height:1px"></div></div>
    </section>
  </div>
  <nav class="bottom-nav glass" aria-label="Secciones" data-nav>
    <button data-v="files" data-href="#/">${icon('cloud')}Mi nube</button>
    <button data-v="recent" data-href="#/recent">${icon('clock')}Recientes</button>
    <button data-v="media" data-href="#/media">${icon('photo')}Fotos</button>
    <button data-v="trash" data-href="#/trash">${icon('trash')}Papelera</button>
  </nav>
  <button class="fab" data-act="upload-menu" aria-label="Subir">${icon('plus', 'lg')}</button>
  <input type="file" multiple hidden data-pick>
  <input type="file" multiple hidden webkitdirectory data-pick-dir>
  <input type="file" hidden data-pick-resume>
  <div class="drop" data-drop><div class="card glass">${art.upload()}<strong>Suelta para subir a Flex Cloud</strong><span style="color:var(--txt2)">Archivos y carpetas, a su tamaño original</span></div></div>
  <div data-transfers></div>`;
  root.addEventListener('click', onClick);
  // Sin manejadores en linea (la CSP solo permite scripts propios): la carga y
  // el fallo de las miniaturas se escuchan aqui, en captura.
  root.addEventListener('load', (e) => { if (e.target.matches?.('img[data-thumb]')) e.target.classList.add('ok'); }, true);
  root.addEventListener('error', (e) => { if (e.target.matches?.('img[data-thumb]')) e.target.remove(); }, true);
  root.addEventListener('contextmenu', onContext);
  root.addEventListener('dblclick', onDouble);
  const search = $('[data-search]');
  let st;
  search.addEventListener('input', () => {
    clearTimeout(st);
    st = setTimeout(() => { const q = search.value.trim(); if (q) go(`#/search/${encodeURIComponent(q)}`); else if (S.route.view === 'search') go('#/'); }, 280);
  });
  $('[data-pick]').onchange = (e) => { uploadFiles([...e.target.files].map((f) => ({ file: f, rel: '' }))); e.target.value = ''; };
  $('[data-pick-dir]').onchange = (e) => { uploadFiles([...e.target.files].map((f) => ({ file: f, rel: f.webkitRelativePath.split('/').slice(0, -1).join('/') }))); e.target.value = ''; };
  new IntersectionObserver((es) => { if (es.some((x) => x.isIntersecting) && S.next && !S.loading) loadMore(); }, { root: $('[data-content]'), rootMargin: '600px' }).observe($('[data-more]'));
  renderQuota();
  renderBanner();
}

function renderNav() {
  for (const n of $$('[data-nav] [data-v]')) n.classList.toggle('on', n.dataset.v === S.route.view);
  const s = $('[data-search]');
  if (s && S.route.view !== 'search' && document.activeElement !== s) s.value = '';
  if (s && S.route.view === 'search' && document.activeElement !== s) s.value = S.route.q;
}

function renderBanner() {
  const b = $('[data-banner]');
  if (!b) return;
  b.innerHTML = navigator.onLine === false
    ? `<div class="banner">${icon('wifiOff')}<span class="grow"><strong>Sin conexión.</strong> Las subidas y descargas esperan y siguen solas al volver la red.</span></div>`
    : '';
}

// --------------------------------------------------------------- cuota
function renderQuota() {
  const el = $('[data-quota]');
  if (!el || !S.quota) return;
  const q = S.quota;
  const live = Math.max(0, q.usedBytes - q.trashBytes);
  const pct = (v) => `${Math.min(100, (v / q.totalBytes) * 100).toFixed(2)}%`;
  const note = q.state === 'full' ? `Almacenamiento lleno. ${q.trashBytes ? 'Vacía la papelera para liberar espacio.' : 'Borra archivos que ya no necesites.'}`
    : q.state === 'low' ? `Queda poco espacio: ${bytes(q.availableBytes)} libres.`
    : `${bytes(q.availableBytes)} libres`;
  el.innerHTML = `<div class="quota ${q.state}" role="group" aria-label="Almacenamiento">
    <div class="quota-head"><strong>Almacenamiento</strong><span>${q.percentUsed}%</span></div>
    <div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${q.percentUsed}">
      <i class="used" style="width:${pct(live)}"></i><i class="trash" style="width:${pct(q.trashBytes)}"></i><i class="reserved" style="width:${pct(q.reservedBytes)}"></i></div>
    <div class="quota-note">${bytes(q.usedBytes + q.reservedBytes)} de ${bytes(q.totalBytes)} usados${q.trashBytes ? ` · ${bytes(q.trashBytes)} en la papelera` : ''}</div>
    <div class="quota-note">${escapeHtml(note)}</div></div>`;
}
async function refreshQuota() { try { S.quota = (await api.quota()).quota; renderQuota(); } catch { /* se queda la anterior */ } }

// --------------------------------------------------------------- vistas
const VIEW_TITLE = { recent: 'Recientes', media: 'Fotos y vídeos', trash: 'Papelera', search: 'Resultados' };

function listParams() {
  const r = S.route;
  const base = { limit: PAGE, sort: S.sort, order: S.order };
  if (r.view === 'files') return { ...base, parentId: r.id };
  if (r.view === 'recent') return { view: 'recent', limit: PAGE };
  if (r.view === 'media') return { view: 'recent', kind: 'media', limit: PAGE };
  if (r.view === 'trash') return { view: 'trash', limit: PAGE };
  return { ...base, view: 'search', q: r.q };
}

async function loadView() {
  const seq = ++S.loadSeq;
  S.loading = true; S.error = null; S.items = []; S.next = null;
  renderView();
  try {
    const r = await api.list(listParams());
    if (seq !== S.loadSeq) return;
    S.items = r.items; S.next = r.nextCursor; S.folder = r.folder;
  } catch (e) {
    if (seq !== S.loadSeq) return;
    if (e.status === 401) return gate(e);
    S.error = e;
  } finally {
    if (seq === S.loadSeq) { S.loading = false; renderView(); }
  }
}

async function loadMore() {
  const seq = S.loadSeq;
  S.loading = true;
  try {
    const r = await api.list({ ...listParams(), cursor: S.next });
    if (seq !== S.loadSeq) return;
    S.items.push(...r.items); S.next = r.nextCursor;
  } catch (e) { toast(e.message, { error: true }); S.next = null; } finally { S.loading = false; renderView(); }
}

function header() {
  const r = S.route;
  let title;
  if (r.view === 'files') {
    const path = S.folder?.path || [];
    title = `<nav class="crumbs" aria-label="Ruta"><button data-go="#/">Mi nube</button>${path.map((p) =>
      `<span class="sep">${icon('chevron', 'sm')}</span><button data-go="${folderHash(p.id)}" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</button>`).join('')}</nav>`;
  } else {
    title = `<div class="crumbs"><button>${escapeHtml(r.view === 'search' ? `Resultados de "${r.q}"` : VIEW_TITLE[r.view])}</button></div>`;
  }
  const sortable = r.view === 'files' || r.view === 'search';
  return `<div class="view-head">${title}
    <div class="toolbar">
      ${r.view === 'files' ? `<button class="btn sm" data-act="new-folder">${icon('folderPlus', 'sm')} Nueva carpeta</button>` : ''}
      ${r.view === 'trash' && S.items.length ? `<button class="btn sm danger" data-act="empty-trash">${icon('trash', 'sm')} Vaciar papelera</button>` : ''}
      ${sortable ? `<select class="sort" data-sort aria-label="Ordenar">
        ${[['name:asc', 'Nombre A–Z'], ['name:desc', 'Nombre Z–A'], ['date:desc', 'Más recientes'], ['date:asc', 'Más antiguos'], ['size:desc', 'Más grandes'], ['size:asc', 'Más pequeños']]
          .map(([v, l]) => `<option value="${v}" ${v === `${S.sort}:${S.order}` ? 'selected' : ''}>${l}</option>`).join('')}</select>` : ''}
      <div class="seg" role="group" aria-label="Vista"><button class="${S.layout === 'grid' ? 'on' : ''}" data-layout="grid" aria-label="Cuadrícula">${icon('grid', 'sm')}</button><button class="${S.layout === 'list' ? 'on' : ''}" data-layout="list" aria-label="Lista">${icon('list', 'sm')}</button></div>
    </div></div>`;
}

function emptyState() {
  const v = S.route.view;
  if (v === 'trash') return `<div class="empty">${art.emptyTrash()}<h2>La papelera está vacía</h2><p>Lo que borres se queda aquí ${'30'} días por si cambias de idea. Mientras tanto sigue ocupando espacio.</p></div>`;
  if (v === 'search') return `<div class="empty">${art.noResults()}<h2>Sin resultados</h2><p>No hay nada que se llame "${escapeHtml(S.route.q)}". Prueba con otra parte del nombre.</p></div>`;
  if (v === 'media') return `<div class="empty">${art.photos()}<h2>Aún no hay fotos ni vídeos</h2><p>Sube fotos y vídeos a su calidad original, o envíalos desde la Galería de tu Flex OS Ultra.</p><div class="actions"><button class="btn primary" data-act="upload">${icon('upload')} Subir fotos o vídeos</button></div></div>`;
  if (v === 'recent') return `<div class="empty">${art.emptyFolder()}<h2>Nada reciente</h2><p>Lo que subas aparecerá aquí primero.</p><div class="actions"><button class="btn primary" data-act="upload">${icon('upload')} Subir archivos</button></div></div>`;
  if (S.quota?.state === 'full') return `<div class="empty">${art.quotaFull()}<h2>Tu Flex Cloud está lleno</h2><p>Libera espacio vaciando la papelera o borrando archivos que no necesites.</p><div class="actions"><a class="btn" href="#/trash">${icon('trash')} Ir a la papelera</a></div></div>`;
  const isRoot = !S.route.id || S.route.id === 'root';
  return `<div class="empty">${isRoot ? art.welcome() : art.emptyFolder()}<h2>${isRoot ? 'Te damos la bienvenida a tu Flex Cloud' : 'Esta carpeta está vacía'}</h2>
    <p>${isRoot ? `Tienes ${bytes(S.quota?.totalBytes || 0)} para tus archivos, que se guardan sin perder calidad. Arrástralos aquí o usa el botón Subir.` : 'Arrastra archivos aquí o crea una subcarpeta.'}</p>
    <div class="actions"><button class="btn primary" data-act="upload">${icon('upload')} Subir archivos</button><button class="btn" data-act="new-folder">${icon('folderPlus')} Nueva carpeta</button></div></div>`;
}

function errorState(e) {
  const off = e.offline;
  return `<div class="empty">${off ? art.offline() : art.error()}<h2>${off ? 'Sin conexión' : 'No se pudo cargar'}</h2><p>${escapeHtml(e.message)}</p>
    <div class="actions"><button class="btn primary" data-act="reload">${icon('retry')} Reintentar</button></div></div>`;
}

function thumbHtml(it, size = 'tile') {
  if (it.type === 'folder') return `<span class="kind k-folder">${kindIcon('folder')}</span>`;
  if (it.hasThumbnail) return `<img loading="lazy" decoding="async" alt="" src="${api.thumbUrl(it.id)}" data-thumb>`;
  return `<span class="kind k-${it.kind}">${kindIcon(it.kind)}</span>`;
}

function subtitle(it) {
  if (S.route.view === 'trash') return `Borrado ${when(it.deletedAt)}${it.type === 'folder' ? ` · ${it.itemCount ?? 0} archivo${it.itemCount === 1 ? '' : 's'}` : ` · ${bytes(it.size)}`}`;
  if (it.type === 'folder') return `Carpeta · ${when(it.updatedAt)}`;
  const dur = it.metadata?.durationMs ? ` · ${duration(it.metadata.durationMs / 1000)}` : '';
  return `${bytes(it.size)} · ${when(it.updatedAt)}${dur}`;
}

function tile(it) {
  const sel = S.sel.has(it.id);
  const badge = it.kind === 'video' && it.metadata?.durationMs ? `<span class="badge">${duration(it.metadata.durationMs / 1000)}</span>` : it.source === 'device' ? '<span class="badge">P4</span>' : '';
  return `<div class="tile ${it.type === 'folder' ? 'folder' : ''} ${sel ? 'sel' : ''}" data-id="${it.id}" tabindex="0" role="button" aria-pressed="${sel}" aria-label="${escapeHtml(it.name)}">
    <div class="thumb">${thumbHtml(it)}${badge}</div>
    <div class="meta"><div class="name" title="${escapeHtml(it.name)}">${escapeHtml(it.name)}</div><div class="sub">${escapeHtml(subtitle(it))}</div></div>
    <button class="more" data-more aria-label="Acciones de ${escapeHtml(it.name)}">${icon('more', 'sm')}</button></div>`;
}

function row(it) {
  const sel = S.sel.has(it.id);
  return `<div class="row ${sel ? 'sel' : ''}" data-id="${it.id}" tabindex="0" role="button" aria-pressed="${sel}">
    <span class="kind ${it.type === 'folder' ? 'k-folder' : (it.hasThumbnail ? '' : 'k-' + it.kind)}">${thumbHtml(it, 'row')}</span>
    <span class="name" title="${escapeHtml(it.name)}">${escapeHtml(it.name)}</span>
    <span class="dim c-size">${it.type === 'folder' ? '—' : bytes(it.size)}</span>
    <span class="dim c-date">${S.route.view === 'trash' ? when(it.deletedAt) : when(it.updatedAt)}</span>
    <button class="icon-btn" data-more aria-label="Acciones">${icon('more', 'sm')}</button></div>`;
}

function renderView() {
  const el = $('[data-view]');
  if (!el) return;
  let body;
  if (S.loading && !S.items.length) {
    body = S.layout === 'grid'
      ? `<div class="grid">${'<div class="skel skel-tile"></div>'.repeat(10)}</div>`
      : `<div class="list">${'<div class="row"><span class="skel" style="width:36px;height:36px;border-radius:11px"></span><span class="skel skel-line"></span></div>'.repeat(8)}</div>`;
  } else if (S.error) body = errorState(S.error);
  else if (!S.items.length) body = emptyState();
  else if (S.layout === 'grid') {
    const folders = S.items.filter((i) => i.type === 'folder'), files = S.items.filter((i) => i.type === 'file');
    body = (folders.length ? `${files.length ? '<div class="section-title">Carpetas</div>' : ''}<div class="grid">${folders.map(tile).join('')}</div>` : '') +
           (files.length ? `${folders.length ? '<div class="section-title" style="margin-top:22px">Archivos</div>' : ''}<div class="grid">${files.map(tile).join('')}</div>` : '');
  } else {
    body = `<div class="list" role="list"><div class="row list-head"><span></span><span>Nombre</span><span class="c-size">Tamaño</span><span class="c-date">${S.route.view === 'trash' ? 'Borrado' : 'Modificado'}</span><span></span></div>${S.items.map(row).join('')}</div>`;
  }
  const selBar = S.sel.size ? selectionBar() : '';
  el.innerHTML = header() + body + selBar;
  const sort = $('[data-sort]', el);
  if (sort) sort.onchange = () => { [S.sort, S.order] = sort.value.split(':'); store.set('sort', S.sort); store.set('order', S.order); loadView(); };
}

function selectionBar() {
  const n = S.sel.size;
  const trash = S.route.view === 'trash';
  return `<div class="transfers glass" style="right:auto;left:50%;transform:translateX(-50%);bottom:${matchMedia('(max-width:640px)').matches ? '150px' : '24px'};width:auto;max-width:calc(100vw - 32px)">
    <header style="gap:6px;flex-wrap:wrap"><strong>${n} seleccionado${n === 1 ? '' : 's'}</strong>
    ${trash ? `<button class="btn sm" data-act="sel-restore">${icon('restore', 'sm')} Restaurar</button><button class="btn sm danger" data-act="sel-destroy">${icon('trash', 'sm')} Eliminar</button>`
            : `<button class="btn sm" data-act="sel-download">${icon('download', 'sm')} Descargar</button><button class="btn sm" data-act="sel-move">${icon('move', 'sm')} Mover</button><button class="btn sm" data-act="sel-trash">${icon('trash', 'sm')} Papelera</button>`}
    <button class="icon-btn" data-act="sel-clear" aria-label="Quitar selección">${icon('close', 'sm')}</button></header></div>`;
}

const itemById = (id) => S.items.find((i) => i.id === id);

// --------------------------------------------------------------- eventos
function onClick(e) {
  const t = e.target;
  const nav = t.closest('[data-href]');
  if (nav) { go(nav.dataset.href); return; }
  const goBtn = t.closest('[data-go]');
  if (goBtn) { go(goBtn.dataset.go); return; }
  const layout = t.closest('[data-layout]');
  if (layout) { S.layout = layout.dataset.layout; store.set('layout', S.layout); renderView(); return; }
  const act = t.closest('[data-act]');
  if (act) { action(act.dataset.act, act, e); return; }
  const card = t.closest('[data-id]');
  if (!card) { if (S.sel.size && !t.closest('.transfers,.menu')) { S.sel.clear(); renderView(); } return; }
  const it = itemById(card.dataset.id);
  if (!it) return;
  if (t.closest('[data-more]')) { const r = t.closest('[data-more]').getBoundingClientRect(); itemMenú(it, r.left, r.bottom + 4); return; }
  if (e.ctrlKey || e.metaKey) { toggleSel(it.id); return; }
  if (e.shiftKey && S.anchor) { rangeSel(S.anchor, it.id); return; }
  if (S.sel.size) { toggleSel(it.id); return; }
  open(it);
}
function onDouble() { /* un toque ya abre: el doble no hace nada distinto */ }
function onContext(e) {
  const card = e.target.closest('[data-id]');
  if (!card) return;
  const it = itemById(card.dataset.id);
  if (!it) return;
  e.preventDefault();
  itemMenú(it, e.clientX, e.clientY);
}
function toggleSel(id) { if (S.sel.has(id)) S.sel.delete(id); else S.sel.add(id); S.anchor = id; renderView(); }
function rangeSel(a, b) {
  const ids = S.items.map((i) => i.id);
  const [i, j] = [ids.indexOf(a), ids.indexOf(b)].sort((x, y) => x - y);
  for (const id of ids.slice(i, j + 1)) S.sel.add(id);
  renderView();
}

function setupKeys() {
  addEventListener('keydown', (e) => {
    if (isModalOpen() || e.target.matches('input, textarea, select')) return;
    if (e.key === 'Escape') { if ($('.viewer')) closeViewer(); else if ($('.details')) closeDetails(); else if (S.sel.size) { S.sel.clear(); renderView(); } }
    const focused = document.activeElement?.closest?.('[data-id]');
    const it = focused && itemById(focused.dataset.id);
    if (e.key === 'Enter' && it && !$('.viewer')) open(it);
    if (e.key === ' ' && it) { e.preventDefault(); toggleSel(it.id); }
    if ((e.key === 'Delete' || e.key === 'Backspace') && (S.sel.size || it) && S.route.view !== 'trash' && !$('.viewer')) { e.preventDefault(); trashItems(S.sel.size ? [...S.sel].map(itemById).filter(Boolean) : [it]); }
    if (e.key === 'F2' && it) { e.preventDefault(); rename(it); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a' && S.items.length) { e.preventDefault(); S.items.forEach((i) => S.sel.add(i.id)); renderView(); }
    if ($('.viewer') && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) viewerStep(e.key === 'ArrowRight' ? 1 : -1);
  });
}

async function action(name, el) {
  switch (name) {
    case 'side': $('.side').classList.add('open'); document.body.append(h('<div class="side-scrim" data-side-scrim></div>')); $('[data-side-scrim]').onclick = closeSide; break;
    case 'upload': $('[data-pick]').click(); break;
    case 'upload-menu': { const r = el.getBoundingClientRect(); menu(r.left, r.bottom + 6, [
      { icon: 'upload', label: 'Subir archivos', run: () => $('[data-pick]').click() },
      { icon: 'folder', label: 'Subir una carpeta', run: () => $('[data-pick-dir]').click() },
      '-', { icon: 'folderPlus', label: 'Nueva carpeta', run: newFolder }]); break; }
    case 'new-folder': newFolder(); break;
    case 'reload': loadView(); break;
    case 'empty-trash': emptyTrash(); break;
    case 'theme': S.theme = S.theme === 'light' ? 'dark' : 'light'; store.set('theme', S.theme); applyTheme(); el.innerHTML = icon(S.theme === 'light' ? 'moon' : 'sun'); break;
    case 'account': accountMenú(el); break;
    case 'device-info': deviceInfo(); break;
    case 'sel-clear': S.sel.clear(); renderView(); break;
    case 'sel-trash': trashItems([...S.sel].map(itemById).filter(Boolean)); break;
    case 'sel-move': moveItems([...S.sel].map(itemById).filter(Boolean)); break;
    case 'sel-download': for (const it of [...S.sel].map(itemById).filter((i) => i?.type === 'file')) await transfers.download(it); break;
    case 'sel-restore': restoreItems([...S.sel].map(itemById).filter(Boolean)); break;
    case 'sel-destroy': destroyItems([...S.sel].map(itemById).filter(Boolean)); break;
    case 'xfer-toggle': S.xferCollapsed = !S.xferCollapsed; renderTransfers(); break;
    case 'xfer-close': transfers.clearFinished(); S.xferHidden = true; renderTransfers(); break;
    case 'xfer-pause': transfers.pause(el.closest('[data-t]').dataset.t); break;
    case 'xfer-resume': transfers.resume(el.closest('[data-t]').dataset.t); break;
    case 'xfer-cancel': transfers.cancel(el.closest('[data-t]').dataset.t); break;
    case 'xfer-retry': transfers.retry(el.closest('[data-t]').dataset.t); break;
    case 'xfer-dismiss': transfers.dismiss(el.closest('[data-t]').dataset.t); break;
    case 'xfer-attach': attachResume(el.closest('[data-t]').dataset.t); break;
    default: break;
  }
}
function closeSide() { $('.side')?.classList.remove('open'); $('[data-side-scrim]')?.remove(); }

function itemMenú(it, x, y) {
  if (S.route.view === 'trash') {
    menu(x, y, [{ icon: 'restore', label: 'Restaurar', run: () => restoreItems([it]) }, '-',
                { icon: 'trash', label: 'Eliminar definitivamente', danger: true, run: () => destroyItems([it]) }]);
    return;
  }
  const items = [{ icon: it.type === 'folder' ? 'folder' : 'play', label: 'Abrir', run: () => open(it) }];
  if (it.type === 'file') items.push({ icon: 'download', label: 'Descargar', run: () => transfers.download(it) });
  items.push({ icon: 'edit', label: 'Cambiar nombre', run: () => rename(it) },
             { icon: 'move', label: 'Mover a…', run: () => moveItems([it]) });
  if (it.type === 'file') items.push({ icon: 'link', label: 'Copiar enlace temporal', run: () => copyLink(it) },
                                     { icon: 'info', label: 'Detalles', run: () => details(it) });
  items.push({ icon: 'check', label: S.sel.has(it.id) ? 'Quitar de la selección' : 'Seleccionar', run: () => toggleSel(it.id) },
             '-', { icon: 'trash', label: 'Mover a la papelera', danger: true, run: () => trashItems([it]) });
  menu(x, y, items);
}

function accountMenú(el) {
  const a = S.me.account;
  const r = el.getBoundingClientRect();
  const items = [{ icon: 'shield', label: `${a.displayName || 'Tu cuenta'} · ${a.flexAddress || ''}`, run: () => {} },
    { icon: S.theme === 'light' ? 'moon' : 'sun', label: S.theme === 'light' ? 'Tema oscuro' : 'Tema claro', run: () => action('theme', $('[data-act="theme"]')) }, '-'];
  items.push({ icon: 'logout', label: 'Cerrar sesión', run: async () => {
    if (S.health?.accountMode === 'dev') { await api.devLogout().catch(() => {}); location.reload(); } else location.href = LOGOUT_URL;
  } });
  menu(r.right - 260, r.bottom + 6, items);
}

function deviceInfo() {
  const d = h(`<div class="scrim"><div class="dialog glass"><h3>${icon('device')} Flex Cloud en Flex OS Ultra</h3>
    <p>Tu Flex OS Ultra usa esta misma nube con tu Flex Account: abre <strong>Archivos › Flex Cloud</strong>, la pestaña <strong>Nube</strong> de la Galería o la de Multimedia. Los vídeos se reproducen por partes, sin descargarlos enteros.</p>
    <p>Si en el P4 aparece "Vuelve a iniciar sesión", vincula de nuevo el dispositivo desde Ajustes › Flex Account.</p>
    <div class="actions"><button class="btn primary">Entendido</button></div></div></div>`);
  document.body.append(d);
  d.querySelector('button').onclick = () => d.remove();
  d.onclick = (e) => { if (e.target === d) d.remove(); };
}

// ------------------------------------------------------------- acciones
function open(it) {
  if (it.type === 'folder') { if (S.route.view !== 'trash') go(folderHash(it.id)); return; }
  if (S.route.view === 'trash') { details(it); return; }
  if (['photo', 'video', 'audio'].includes(it.kind) || it.mime === 'text/plain' || it.mime === 'text/markdown' || it.mime === 'text/csv') viewer(it);
  else details(it);
}

async function newFolder() {
  const parentId = S.route.view === 'files' ? S.route.id : 'root';
  const name = await prompt({ title: 'Nueva carpeta', placeholder: 'Nombre de la carpeta', ok: 'Crear' });
  if (!name) return;
  try {
    await api.createFolder(name, parentId === 'root' ? null : parentId);
    toast(`Carpeta "${name}" creada`);
    if (S.route.view === 'files') loadView();
  } catch (e) { toast(e.message, { error: true }); }
}

async function rename(it) {
  const name = await prompt({ title: 'Cambiar nombre', value: it.name, ok: 'Guardar' });
  if (!name || name === it.name) return;
  try {
    if (it.type === 'folder') await api.renameFolder(it.id, name); else await api.renameFile(it.id, name);
    loadView();
  } catch (e) { toast(e.message, { error: true }); }
}

async function moveItems(list) {
  if (!list.length) return;
  const exclude = new Set(list.filter((i) => i.type === 'folder').map((i) => i.id));
  const dest = await pickFolder({ title: list.length === 1 ? `Mover "${list[0].name}"` : `Mover ${list.length} elementos`, exclude,
    load: async (id) => { const r = await api.list({ parentId: id, limit: 200, sort: 'name' }); return { folder: r.folder, items: r.items }; } });
  if (!dest) return;
  let ok = 0;
  for (const it of list) {
    try { if (it.type === 'folder') await api.moveFolder(it.id, dest === 'root' ? null : dest); else await api.moveFile(it.id, dest === 'root' ? null : dest); ok++; }
    catch (e) { toast(`${it.name}: ${e.message}`, { error: true }); }
  }
  if (ok) toast(`${ok} elemento${ok === 1 ? '' : 's'} movido${ok === 1 ? '' : 's'}`);
  S.sel.clear(); loadView();
}

async function trashItems(list) {
  if (!list.length) return;
  const done = [];
  for (const it of list) { try { await api.trash(it.type, it.id); done.push(it); } catch (e) { toast(`${it.name}: ${e.message}`, { error: true }); } }
  if (!done.length) return;
  S.sel.clear(); loadView(); refreshQuota(); closeDetails(); closeViewer();
  toast(done.length === 1 ? `"${done[0].name}" se movió a la papelera` : `${done.length} elementos en la papelera`, {
    action: 'Deshacer', onAction: async () => { for (const it of done) await api.restore(it.type, it.id).catch(() => {}); loadView(); refreshQuota(); },
  });
}

async function restoreItems(list) {
  let n = 0;
  for (const it of list) { try { await api.restore(it.type, it.id); n++; } catch (e) { toast(`${it.name}: ${e.message}`, { error: true }); } }
  if (n) toast(`${n} elemento${n === 1 ? '' : 's'} restaurado${n === 1 ? '' : 's'}`);
  S.sel.clear(); loadView(); refreshQuota();
}

async function destroyItems(list) {
  const ok = await confirm({ title: list.length === 1 ? `Eliminar "${list[0].name}"` : `Eliminar ${list.length} elementos`,
    text: 'Se borrarán para siempre y liberarán su espacio. No se puede deshacer.', ok: 'Eliminar definitivamente', danger: true });
  if (!ok) return;
  clearToasts();
  let freed = 0;
  for (const it of list) { try { freed += (await api.destroy(it.type, it.id)).freedBytes || 0; } catch (e) { toast(`${it.name}: ${e.message}`, { error: true }); } }
  toast(`Eliminado. Liberaste ${bytes(freed)}.`);
  S.sel.clear(); loadView(); refreshQuota();
}

async function emptyTrash() {
  const ok = await confirm({ title: 'Vaciar la papelera', text: 'Todo lo que hay en la papelera se borrará para siempre. No se puede deshacer.', ok: 'Vaciar', danger: true });
  if (!ok) return;
  clearToasts();
  try { const r = await api.emptyTrash(); toast(`Papelera vacía. Liberaste ${bytes(r.freedBytes)}.`); } catch (e) { toast(e.message, { error: true }); }
  loadView(); refreshQuota();
}

async function copyLink(it) {
  try {
    const r = await api.link(it.id);
    const url = new URL(r.path, location.origin).href;
    await navigator.clipboard.writeText(url);
    toast('Enlace temporal copiado: caduca en 15 minutos');
  } catch (e) { toast(e.message || 'No se pudo copiar el enlace', { error: true }); }
}

// ------------------------------------------------------------- detalles
function closeDetails() { $('.details')?.remove(); }
async function details(it) {
  closeDetails();
  let f = it;
  if (it.type === 'file') { try { f = (await api.file(it.id)).file; } catch { /* lo que habia */ } }
  const where = ['Mi nube', ...(f.path || []).map((p) => p.name)].join(' › ');
  const m = f.metadata || {};
  const el = h(`<aside class="details glass" role="dialog" aria-label="Detalles">
    <div style="display:flex;align-items:center;gap:8px"><h3 style="flex:1">${escapeHtml(f.name)}</h3><button class="icon-btn" data-x aria-label="Cerrar">${icon('close')}</button></div>
    <div class="preview">${f.type === 'file' && f.hasThumbnail ? `<img alt="" src="${api.thumbUrl(f.id)}">` : `<span class="kind k-${f.type === 'folder' ? 'folder' : f.kind}" style="width:72px;height:72px;border-radius:22px;display:grid;place-items:center">${kindIcon(f.type === 'folder' ? 'folder' : f.kind)}</span>`}</div>
    ${f.type === 'file' && !f.deletedAt ? `<div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn primary sm" data-dl>${icon('download', 'sm')} Descargar</button>${['photo', 'video', 'audio'].includes(f.kind) ? `<button class="btn sm" data-view>${icon('play', 'sm')} Ver</button>` : ''}<button class="btn sm" data-link>${icon('link', 'sm')} Enlace</button></div>` : ''}
    <dl class="kv">
      <dt>Tipo</dt><dd>${escapeHtml(f.type === 'folder' ? 'Carpeta' : `${KIND_LABEL[f.kind] || 'Archivo'} · ${f.mime}`)}</dd>
      ${f.type === 'file' ? `<dt>Tamaño</dt><dd>${bytes(f.size)} <span style="color:var(--txt2)">(${f.size.toLocaleString('es')} bytes)</span></dd>` : ''}
      ${m.width ? `<dt>Dimensiones</dt><dd>${m.width} × ${m.height}</dd>` : ''}
      ${m.durationMs ? `<dt>Duración</dt><dd>${duration(m.durationMs / 1000)}</dd>` : ''}
      <dt>Ubicación</dt><dd>${escapeHtml(where)}</dd>
      <dt>Creado</dt><dd>${fullDate(f.createdAt)}</dd>
      <dt>Modificado</dt><dd>${fullDate(f.updatedAt)}</dd>
      ${f.deletedAt ? `<dt>En la papelera</dt><dd>desde ${fullDate(f.deletedAt)}</dd>` : ''}
      ${f.type === 'file' ? `<dt>Origen</dt><dd>${f.source === 'device' ? 'Flex OS Ultra' : 'Web'}</dd>
      <dt>Calidad</dt><dd>Original, sin recomprimir</dd>
      <dt>Versión</dt><dd>${f.version}</dd>
      <dt>SHA-256</dt><dd><code>${f.sha256}</code></dd>` : ''}
    </dl></aside>`);
  document.body.append(el);
  el.querySelector('[data-x]').onclick = closeDetails;
  el.querySelector('[data-dl]')?.addEventListener('click', () => transfers.download(f));
  el.querySelector('[data-view]')?.addEventListener('click', () => viewer(f));
  el.querySelector('[data-link]')?.addEventListener('click', () => copyLink(f));
}

// ---------------------------------------------------------------- visor
let viewerItem = null;
function closeViewer() {
  const v = $('.viewer');
  if (!v) return;
  v.querySelectorAll('video,audio').forEach((m) => { m.pause(); m.removeAttribute('src'); m.load(); });   // suelta la conexión
  v.remove(); viewerItem = null;
}
function viewerStep(d) {
  const media = S.items.filter((i) => i.type === 'file' && ['photo', 'video', 'audio'].includes(i.kind));
  const i = media.findIndex((x) => x.id === viewerItem?.id);
  const n = media[i + d];
  if (n) viewer(n);
}
async function viewer(it) {
  closeViewer();
  viewerItem = it;
  const src = api.downloadUrl(it.id, true);
  let body;
  if (it.kind === 'photo') body = `<img alt="${escapeHtml(it.name)}" src="${src}">`;
  // El video se reproduce por rangos (Range): el navegador pide trozos, no el archivo entero.
  else if (it.kind === 'video') body = `<video controls autoplay playsinline preload="metadata" src="${src}"></video>`;
  else if (it.kind === 'audio') body = `<audio controls autoplay src="${src}"></audio>`;
  else body = '<pre>Cargando…</pre>';
  const v = h(`<div class="viewer" role="dialog" aria-label="${escapeHtml(it.name)}">
    <div class="viewer-bar"><button class="icon-btn" data-x aria-label="Cerrar">${icon('back')}</button><span class="title">${escapeHtml(it.name)}</span>
      <button class="icon-btn" data-info aria-label="Detalles">${icon('info')}</button><button class="icon-btn" data-dl aria-label="Descargar">${icon('download')}</button></div>
    <div class="viewer-body">${body}</div>
    <button class="nav-prev" data-p aria-label="Anterior">${icon('back')}</button><button class="nav-next" data-n aria-label="Siguiente">${icon('chevron')}</button></div>`);
  document.body.append(v);
  v.querySelector('[data-x]').onclick = closeViewer;
  v.querySelector('[data-dl]').onclick = () => transfers.download(it);
  v.querySelector('[data-info]').onclick = () => details(it);
  v.querySelector('[data-p]').onclick = () => viewerStep(-1);
  v.querySelector('[data-n]').onclick = () => viewerStep(1);
  const media = v.querySelector('video,audio,img');
  if (media) media.addEventListener('error', () => { v.querySelector('.viewer-body').innerHTML = `<div class="empty">${art.error()}<h2>Este navegador no puede reproducirlo</h2><p>El archivo está intacto en tu nube. Descárgalo para abrirlo con otra app.</p></div>`; }, { once: true });
  if (!media) {
    try {
      const r = await fetch(src, { headers: { range: 'bytes=0-262143' }, credentials: 'same-origin' });
      const text = await r.text();
      v.querySelector('pre').textContent = text + (it.size > 262144 ? '\n\n… (vista previa de los primeros 256 KB)' : '');
    } catch { v.querySelector('pre').textContent = 'No se pudo cargar la vista previa.'; }
  }
}

// ------------------------------------------------------------ subidas
async function uploadFiles(entries) {
  if (!entries.length) return;
  const base = S.route.view === 'files' && S.route.id !== 'root' ? S.route.id : null;
  if (S.quota) {
    const total = entries.reduce((s, e) => s + e.file.size, 0);
    if (total > S.quota.availableBytes) toast(`No hay espacio para todo: necesitas ${bytes(total)} y quedan ${bytes(S.quota.availableBytes)}. Se subirá lo que quepa.`, { error: true, ms: 7000 });
  }
  // Carpetas: se crean una vez cada ruta (con nombre libre si ya existe).
  const made = new Map();
  async function folderFor(rel) {
    if (!rel) return base;
    if (made.has(rel)) return made.get(rel);
    const parts = rel.split('/');
    const parent = await folderFor(parts.slice(0, -1).join('/'));
    const f = (await api.createFolder(parts[parts.length - 1], parent, made.size ? 'fail' : 'rename').catch(async (e) => {
      if (e.code === 'name_conflict') {
        const r = await api.list({ parentId: parent || 'root', view: 'search', q: parts[parts.length - 1], limit: 50 });
        const ex = r.items.find((i) => i.type === 'folder' && i.name === parts[parts.length - 1] && (i.parentId || null) === (parent || null));
        if (ex) return { folder: ex };
      }
      throw e;
    })).folder;
    made.set(rel, f.id);
    return f.id;
  }
  S.xferHidden = false; S.xferCollapsed = false;
  for (const e of entries) {
    try { transfers.addUpload(e.file, await folderFor(e.rel)); } catch (x) { toast(`${e.file.name}: ${x.message}`, { error: true }); }
  }
  if (entries.some((e) => e.rel)) loadView();
}

let reloadTimer;
function onUploaded() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => { if (S.route.view !== 'trash') loadView(); refreshQuota(); }, 350);
}
function refreshThumb(fileId) {
  const it = itemById(fileId);
  if (it) { it.hasThumbnail = true; renderView(); }
}

function attachResume(taskId) {
  const t = transfers.tasks.get(taskId);
  const inp = $('[data-pick-resume]');
  inp.onchange = () => {
    const f = inp.files[0];
    inp.value = '';
    if (!f) return;
    if (!transfers.attachFile(taskId, f)) toast(`Ese no es "${t.name}" (${bytes(t.size)}). Elige el mismo archivo para continuar.`, { error: true });
  };
  inp.click();
}

function setupDrop() {
  const drop = $('[data-drop]');
  let depth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth++; drop.classList.add('on'); });
  addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; depth = Math.max(0, depth - 1); if (!depth) drop.classList.remove('on'); });
  addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  addEventListener('drop', async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); depth = 0; drop.classList.remove('on');
    if (S.route.view === 'trash') { toast('No se puede subir a la papelera', { error: true }); return; }
    const items = [...(e.dataTransfer.items || [])];
    const entries = items.map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
    if (!entries.length) { uploadFiles([...e.dataTransfer.files].map((f) => ({ file: f, rel: '' }))); return; }
    const out = [];
    const walk = async (entry, rel) => {
      if (entry.isFile) { out.push({ file: await new Promise((r, j) => entry.file(r, j)), rel }); return; }
      const reader = entry.createReader();
      const dirRel = rel ? `${rel}/${entry.name}` : entry.name;
      for (;;) {
        const batch = await new Promise((r, j) => reader.readEntries(r, j));
        if (!batch.length) break;
        for (const ch of batch) await walk(ch, dirRel);
      }
    };
    for (const en of entries) await walk(en, '').catch(() => {});
    uploadFiles(out);
  });
}

// ------------------------------------------------------- transferencias
const XFER_TEXT = {
  queued: 'En cola', preparing: 'Preparando…', paused: 'En pausa', waiting: 'Esperando conexión Wi-Fi…',
  completing: 'Verificando integridad (SHA-256)…', done: 'Listo', cancelled: 'Cancelado',
  needsFile: 'Vuelve a elegir el archivo para continuar',
};
function xferStatus(t) {
  if (t.state === 'uploading' || t.state === 'downloading') {
    const b = transfers.bytesOf(t);
    const eta = t.rate > 0 ? ` · ${duration((t.size - b) / t.rate)}` : '';
    return `${t.type === 'upload' ? 'Subiendo' : 'Descargando'} · ${bytes(b)} de ${bytes(t.size)}${t.rate ? ` · ${bytes(t.rate)}/s` : ''}${eta}`;
  }
  if (t.state === 'retrying') return `Reintentando en ${Math.max(1, Math.ceil(((t.retryAt || Date.now()) - Date.now()) / 1000))} s…`;
  if (t.state === 'error') return t.error || 'Error';
  if (t.state === 'done') return t.type === 'upload' ? `Subido · ${bytes(t.size)} · original intacto` : `Descargado · ${bytes(t.size)}`;
  return XFER_TEXT[t.state] || t.state;
}
// Con todo terminado y sin errores, el panel se recoge solo: no se queda
// tapando la nube.
let xferAutoHide;
function scheduleXferHide() {
  clearTimeout(xferAutoHide);
  const list = transfers.list();
  if (!list.length || transfers.active().length || list.some((t) => t.state === 'error' || t.state === 'needsFile')) return;
  xferAutoHide = setTimeout(() => { transfers.clearFinished(); S.xferHidden = true; renderTransfers(); }, 6000);
}
function renderTransfers() {
  const el = $('[data-transfers]');
  if (!el) return;
  scheduleXferHide();
  const list = transfers.list();
  if (!list.length || S.xferHidden && !transfers.active().length) { el.innerHTML = ''; return; }
  if (transfers.active().length) S.xferHidden = false;
  const active = transfers.active();
  const totalSize = list.reduce((s, t) => s + (t.size || 0), 0);
  const totalDone = list.reduce((s, t) => s + transfers.bytesOf(t), 0);
  const pct = totalSize ? Math.round((totalDone / totalSize) * 100) : 100;
  const title = active.length ? `${active.some((t) => t.type === 'upload') ? 'Subiendo' : 'Descargando'} ${active.length} archivo${active.length === 1 ? '' : 's'} · ${pct}%`
    : list.some((t) => t.state === 'error') ? 'Algunas transferencias fallaron' : 'Transferencias terminadas';
  el.innerHTML = `<section class="transfers glass ${S.xferCollapsed ? 'collapsed' : ''}" aria-label="Transferencias">
    <header><strong>${title}</strong>
      <button class="icon-btn" data-act="xfer-toggle" aria-label="${S.xferCollapsed ? 'Expandir' : 'Contraer'}" aria-expanded="${!S.xferCollapsed}">${icon(S.xferCollapsed ? 'up' : 'down', 'sm')}</button>
      ${!active.length ? `<button class="icon-btn" data-act="xfer-close" aria-label="Cerrar">${icon('close', 'sm')}</button>` : ''}</header>
    <div class="overall"><i style="width:${pct}%"></i></div>
    <ul>${list.slice().reverse().map((t) => {
      const p = Math.round(transfers.progressOf(t) * 100);
      const cls = t.state === 'error' ? 'error' : t.state === 'paused' ? 'paused' : t.state === 'waiting' || t.state === 'retrying' ? 'waiting' : '';
      const sCls = t.state === 'error' ? 'err' : t.state === 'done' ? 'ok' : (t.state === 'waiting' || t.state === 'retrying' || t.state === 'needsFile') ? 'warn' : '';
      const k = t.type === 'download' ? (t.kind || 'other') : kindOfMime(t.file?.type || '');
      const acts = [];
      if (['uploading', 'downloading', 'waiting', 'retrying', 'queued', 'preparing'].includes(t.state)) acts.push(`<button class="icon-btn" data-act="xfer-pause" aria-label="Pausar">${icon('pause', 'sm')}</button>`);
      if (t.state === 'paused') acts.push(`<button class="icon-btn" data-act="xfer-resume" aria-label="Reanudar">${icon('play', 'sm')}</button>`);
      if (t.state === 'error') acts.push(`<button class="icon-btn" data-act="xfer-retry" aria-label="Reintentar">${icon('retry', 'sm')}</button>`);
      if (t.state === 'needsFile') acts.push(`<button class="icon-btn" data-act="xfer-attach" aria-label="Elegir archivo">${icon('upload', 'sm')}</button>`);
      if (!['done', 'cancelled', 'error'].includes(t.state)) acts.push(`<button class="icon-btn" data-act="xfer-cancel" aria-label="Cancelar">${icon('close', 'sm')}</button>`);
      else acts.push(`<button class="icon-btn" data-act="xfer-dismiss" aria-label="Quitar de la lista">${icon('close', 'sm')}</button>`);
      return `<li class="xfer ${cls}" data-t="${t.id}"><span class="kind k-${k}">${icon(t.type === 'download' ? 'download' : 'upload', 'sm')}</span>
        <div style="min-width:0"><div class="n" title="${escapeHtml(t.name)}">${escapeHtml(t.name)}</div><div class="s ${sCls}">${escapeHtml(xferStatus(t))}</div>
        ${t.state !== 'done' && t.state !== 'cancelled' ? `<div class="pb" role="progressbar" aria-valuenow="${p}" aria-valuemin="0" aria-valuemax="100"><i style="width:${p}%"></i></div>` : ''}</div>
        <div class="acts">${acts.join('')}</div></li>`;
    }).join('')}</ul></section>`;
}

function applyTheme() {
  if (S.theme === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.dataset.theme = S.theme;
}

boot();
