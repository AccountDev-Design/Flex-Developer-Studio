// Componentes de interfaz: avisos, dialogos y menus. Una sola capa modal a la
// vez; Escape cierra; el foco vuelve a donde estaba.
import { escapeHtml } from './format.js';
import { icon } from './icons.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function h(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

// ----------------------------------------------------------------- avisos
let toastRoot;
// Un aviso con accion (Deshacer) deja de tener sentido tras otra accion que lo
// invalida (vaciar la papelera, borrar definitivamente).
export function clearToasts() { toastRoot?.replaceChildren(); }
export function toast(message, { error = false, action, onAction, ms = 4200 } = {}) {
  toastRoot ||= document.body.appendChild(h('<div class="toasts" role="status" aria-live="polite"></div>'));
  const el = h(`<div class="toast${error ? ' err' : ''}">${error ? icon('alert', 'sm') : icon('check', 'sm')}<span>${escapeHtml(message)}</span>${action ? `<button class="btn sm">${escapeHtml(action)}</button>` : ''}</div>`);
  toastRoot.append(el);
  const close = () => { el.style.opacity = '0'; el.style.transition = 'opacity .2s'; setTimeout(() => el.remove(), 200); };
  if (action) el.querySelector('button').onclick = () => { close(); onAction?.(); };
  setTimeout(close, ms);
  while (toastRoot.children.length > 3) toastRoot.firstElementChild.remove();
}

// ---------------------------------------------------------------- dialogos
let modalOpen = null;
export function closeModal() { modalOpen?.(); }
export function isModalOpen() { return !!modalOpen; }

function openScrim(inner, { onClose } = {}) {
  closeModal();
  const prevFocus = document.activeElement;
  const scrim = h(`<div class="scrim" role="presentation"></div>`);
  scrim.append(inner);
  document.body.append(scrim);
  const close = () => {
    if (!scrim.isConnected) return;
    scrim.remove(); modalOpen = null; removeEventListener('keydown', onKey, true);
    prevFocus?.focus?.(); onClose?.();
  };
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
  addEventListener('keydown', onKey, true);
  scrim.addEventListener('mousedown', (e) => { if (e.target === scrim) close(); });
  modalOpen = close;
  return close;
}

export function prompt({ title, text = '', value = '', placeholder = '', ok = 'Aceptar', validate }) {
  return new Promise((resolve) => {
    const d = h(`<form class="dialog glass" role="dialog" aria-modal="true" aria-labelledby="dlg-t">
      <h3 id="dlg-t">${escapeHtml(title)}</h3>${text ? `<p>${escapeHtml(text)}</p>` : ''}
      <input class="field" name="v" maxlength="255" autocomplete="off" spellcheck="false" placeholder="${escapeHtml(placeholder)}">
      <div class="err" aria-live="polite"></div>
      <div class="actions"><button type="button" class="btn ghost" data-x>Cancelar</button><button class="btn primary">${escapeHtml(ok)}</button></div></form>`);
    const input = d.elements.v;
    input.value = value;
    let result = null;
    const close = openScrim(d, { onClose: () => resolve(result) });
    d.querySelector('[data-x]').onclick = close;
    d.onsubmit = async (e) => {
      e.preventDefault();
      const v = input.value.trim();
      const err = validate ? await validate(v) : (!v ? 'Escribe un nombre.' : null);
      if (err) { d.querySelector('.err').textContent = err; input.focus(); return; }
      result = v; close();
    };
    setTimeout(() => {
      input.focus();
      const dot = value.lastIndexOf('.');
      input.setSelectionRange(0, dot > 0 ? dot : value.length);       // el nombre sin la extension
    }, 30);
  });
}

export function confirm({ title, text, ok = 'Aceptar', danger = false }) {
  return new Promise((resolve) => {
    const d = h(`<div class="dialog glass" role="alertdialog" aria-modal="true" aria-labelledby="dlg-t">
      <h3 id="dlg-t">${escapeHtml(title)}</h3><p>${escapeHtml(text)}</p>
      <div class="actions"><button class="btn ghost" data-x>Cancelar</button><button class="btn ${danger ? 'danger' : 'primary'}" data-ok>${escapeHtml(ok)}</button></div></div>`);
    let result = false;
    const close = openScrim(d, { onClose: () => resolve(result) });
    d.querySelector('[data-x]').onclick = close;
    d.querySelector('[data-ok]').onclick = () => { result = true; close(); };
    setTimeout(() => d.querySelector('[data-ok]').focus(), 30);
  });
}

// Selector de carpeta destino (Mover). `load(id)` devuelve {folder, items}.
export function pickFolder({ title, load, exclude = new Set() }) {
  return new Promise((resolve) => {
    const d = h(`<div class="dialog glass" role="dialog" aria-modal="true" aria-labelledby="dlg-t">
      <h3 id="dlg-t">${escapeHtml(title)}</h3><p class="where"></p><div class="picker" role="listbox"></div>
      <div class="actions"><button class="btn ghost" data-x>Cancelar</button><button class="btn primary" data-ok>Mover aquí</button></div></div>`);
    let current = 'root', result = null;
    const close = openScrim(d, { onClose: () => resolve(result) });
    d.querySelector('[data-x]').onclick = close;
    d.querySelector('[data-ok]').onclick = () => { result = current; close(); };
    const render = async (id) => {
      current = id;
      const box = d.querySelector('.picker');
      box.innerHTML = '<div class="skel skel-line" style="margin:12px"></div>';
      const { folder, items } = await load(id);
      const path = folder.path || [];
      d.querySelector('.where').textContent = ['Mi nube', ...path.map((p) => p.name)].join(' › ');
      const up = path.length ? `<button data-go="${path.length > 1 ? path[path.length - 2].id : 'root'}">${icon('back', 'sm')} Subir un nivel</button>` : '';
      const rows = items.filter((i) => i.type === 'folder' && !exclude.has(i.id))
        .map((i) => `<button data-go="${i.id}">${icon('folder', 'sm')} ${escapeHtml(i.name)}</button>`).join('');
      box.innerHTML = up + (rows || '<p style="padding:12px;margin:0;color:var(--txt2)">Sin subcarpetas</p>');
      box.querySelectorAll('[data-go]').forEach((b) => { b.onclick = () => render(b.dataset.go); });
    };
    render('root');
  });
}

// -------------------------------------------------------------- menus
let menuEl = null;
export function closeMenú() { menuEl?.remove(); menuEl = null; }
export function menu(x, y, items) {
  closeMenú();
  menuEl = h(`<div class="menu glass" role="menu"></div>`);
  for (const it of items) {
    if (it === '-') { menuEl.append(h('<hr>')); continue; }
    const b = h(`<button role="menuitem" class="${it.danger ? 'danger' : ''}">${icon(it.icon, 'sm')}<span>${escapeHtml(it.label)}</span></button>`);
    b.onclick = () => { closeMenú(); it.run(); };
    menuEl.append(b);
  }
  document.body.append(menuEl);
  const r = menuEl.getBoundingClientRect();
  menuEl.style.left = `${Math.max(8, Math.min(x, innerWidth - r.width - 8))}px`;
  menuEl.style.top = `${Math.max(8, Math.min(y, innerHeight - r.height - 8))}px`;
  menuEl.querySelector('button')?.focus();
  menuEl.addEventListener('keydown', (e) => {
    const bs = $$('button', menuEl);
    const i = bs.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); bs[(i + 1) % bs.length].focus(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); bs[(i - 1 + bs.length) % bs.length].focus(); }
    if (e.key === 'Escape') closeMenú();
  });
}
addEventListener('mousedown', (e) => { if (menuEl && !menuEl.contains(e.target)) closeMenú(); }, true);
addEventListener('scroll', closeMenú, true);
addEventListener('resize', closeMenú);
