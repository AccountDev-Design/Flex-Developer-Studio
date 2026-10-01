// Ilustraciones de Flex Cloud. Todas comparten paleta (el gradiente de la
// marca), luz desde arriba a la izquierda y el "vidrio" de Flex OS. Son SVG en
// linea: no se descarga nada y se adaptan al tema claro/oscuro.
let seq = 0;
const uid = () => `a${++seq}`;

function defs(id) {
  return `<defs>
    <linearGradient id="${id}b" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4f7dff"/><stop offset=".55" stop-color="#9b6bff"/><stop offset="1" stop-color="#3fd0c9"/></linearGradient>
    <linearGradient id="${id}g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".55"/><stop offset="1" stop-color="#fff" stop-opacity=".08"/></linearGradient>
    <linearGradient id="${id}c" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#7aa0ff"/><stop offset="1" stop-color="#4f7dff"/></linearGradient>
    <radialGradient id="${id}h" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="#9b6bff" stop-opacity=".45"/><stop offset="1" stop-color="#9b6bff" stop-opacity="0"/></radialGradient>
  </defs>`;
}
const svg = (inner, id, label) => `<svg class="art" viewBox="0 0 320 220" role="img" aria-label="${label}">${defs(id)}${inner}</svg>`;
const cloudPath = 'M96 150h128a34 34 0 0 0 3-67.9A46 46 0 0 0 139 70a40 40 0 0 0-54 27A27 27 0 0 0 96 150z';
const sparkles = (id) => `
  <g fill="url(#${id}b)"><path d="M48 52l4 10 10 4-10 4-4 10-4-10-10-4 10-4z" opacity=".8"/><path d="M270 40l3 7 7 3-7 3-3 7-3-7-7-3 7-3z" opacity=".7"/><circle cx="282" cy="150" r="4" opacity=".6"/><circle cx="36" cy="160" r="3" opacity=".5"/></g>`;
const halo = (id) => `<ellipse cx="160" cy="112" rx="140" ry="96" fill="url(#${id}h)"/>`;
const shadow = '<ellipse cx="160" cy="196" rx="86" ry="9" fill="#000" opacity=".18"/>';

export const art = {
  welcome() {
    const id = uid();
    return svg(`${halo(id)}${shadow}
      <path d="${cloudPath}" fill="url(#${id}b)"/><path d="${cloudPath}" fill="url(#${id}g)"/>
      <rect x="60" y="120" width="54" height="80" rx="10" fill="#141c38" stroke="url(#${id}b)" stroke-width="3"/>
      <rect x="66" y="128" width="42" height="56" rx="5" fill="url(#${id}c)" opacity=".85"/>
      <rect x="196" y="132" width="76" height="52" rx="6" fill="#141c38" stroke="url(#${id}b)" stroke-width="3"/>
      <rect x="203" y="139" width="62" height="38" rx="3" fill="#3fd0c9" opacity=".55"/><rect x="186" y="186" width="96" height="6" rx="3" fill="#7aa0ff"/>
      <path d="M118 150q20-30 40-32M200 156q-14-28-38-30" stroke="#fff" stroke-width="2.5" fill="none" stroke-dasharray="4 6" opacity=".7"/>
      <path d="M152 92v34M140 104l12-12 12 12" stroke="#fff" stroke-width="5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
      ${sparkles(id)}`, id, 'Tu nube y tus dispositivos conectados');
  },
  emptyFolder() {
    const id = uid();
    return svg(`${halo(id)}${shadow}
      <path d="M78 74a10 10 0 0 1 10-10h40l12 12h92a10 10 0 0 1 10 10v94a10 10 0 0 1-10 10H88a10 10 0 0 1-10-10z" fill="url(#${id}c)"/>
      <path d="M70 104a10 10 0 0 1 10-10h162a10 10 0 0 1 10 11l-8 76a10 10 0 0 1-10 9H88a10 10 0 0 1-10-9z" fill="url(#${id}b)"/>
      <path d="M70 104a10 10 0 0 1 10-10h162a10 10 0 0 1 10 11l-1 8H71z" fill="url(#${id}g)"/>
      <path d="M160 128v30M146 142l14-14 14 14" stroke="#fff" stroke-width="5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
      ${sparkles(id)}`, id, 'Carpeta vacía');
  },
  photos() {
    const id = uid();
    return svg(`${halo(id)}${shadow}
      <g transform="rotate(-8 130 120)"><rect x="70" y="58" width="120" height="108" rx="12" fill="#fff" opacity=".9"/><rect x="80" y="68" width="100" height="74" rx="6" fill="url(#${id}c)"/></g>
      <g transform="rotate(7 190 120)"><rect x="132" y="54" width="124" height="112" rx="12" fill="#fff"/><rect x="142" y="64" width="104" height="78" rx="6" fill="url(#${id}b)"/>
      <circle cx="170" cy="88" r="9" fill="#fff" opacity=".85"/><path d="M142 132l30-26 22 18 18-12 34 30v0H142z" fill="#141c38" opacity=".55"/></g>
      ${sparkles(id)}`, id, 'Sin fotos ni vídeos');
  },
  emptyTrash() {
    const id = uid();
    return svg(`${halo(id)}${shadow}
      <rect x="112" y="78" width="96" height="112" rx="14" fill="url(#${id}b)"/><rect x="112" y="78" width="96" height="40" rx="14" fill="url(#${id}g)"/>
      <rect x="100" y="64" width="120" height="18" rx="9" fill="url(#${id}c)"/><rect x="146" y="52" width="28" height="14" rx="6" fill="url(#${id}c)"/>
      <path d="M140 102v66M160 102v66M180 102v66" stroke="#fff" stroke-width="5" stroke-linecap="round" opacity=".55"/>
      <circle cx="230" cy="80" r="18" fill="#39c98a"/><path d="M221 80l6 6 12-12" stroke="#fff" stroke-width="4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
      ${sparkles(id)}`, id, 'Papelera vacía');
  },
  noResults() {
    const id = uid();
    return svg(`${halo(id)}${shadow}
      <path d="${cloudPath}" fill="url(#${id}c)" opacity=".35"/>
      <circle cx="146" cy="112" r="44" fill="url(#${id}g)" stroke="url(#${id}b)" stroke-width="10"/>
      <path d="M178 144l34 34" stroke="url(#${id}b)" stroke-width="14" stroke-linecap="round"/>
      <path d="M130 104q16-14 32 0" stroke="#fff" stroke-width="5" fill="none" stroke-linecap="round" opacity=".8"/>
      ${sparkles(id)}`, id, 'Sin resultados');
  },
  offline() {
    const id = uid();
    return svg(`${halo(id)}${shadow}
      <path d="${cloudPath}" fill="url(#${id}b)" opacity=".85"/><path d="${cloudPath}" fill="url(#${id}g)"/>
      <path d="M126 128a48 48 0 0 1 68 0M138 142a30 30 0 0 1 44 0" stroke="#fff" stroke-width="6" fill="none" stroke-linecap="round"/>
      <circle cx="160" cy="156" r="5" fill="#fff"/><path d="M116 92l90 90" stroke="#ff6b6b" stroke-width="8" stroke-linecap="round"/>
      ${sparkles(id)}`, id, 'Sin conexión');
  },
  error() {
    const id = uid();
    return svg(`${halo(id)}${shadow}
      <path d="${cloudPath}" fill="url(#${id}b)" opacity=".85"/><path d="${cloudPath}" fill="url(#${id}g)"/>
      <path d="M160 92l34 58h-68z" fill="#f2b14b" stroke="#fff" stroke-width="4" stroke-linejoin="round"/>
      <path d="M160 112v18M160 140h.01" stroke="#141c38" stroke-width="6" stroke-linecap="round"/>`, id, 'Algo salió mal');
  },
  upload() {
    const id = uid();
    return svg(`${halo(id)}
      <path d="${cloudPath}" fill="url(#${id}b)"/><path d="${cloudPath}" fill="url(#${id}g)"/>
      <path d="M160 160v-56M136 126l24-24 24 24" stroke="#fff" stroke-width="9" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
      ${sparkles(id)}`, id, 'Suelta para subir');
  },
  quotaFull() {
    const id = uid();
    return svg(`${halo(id)}${shadow}
      <rect x="90" y="70" width="140" height="110" rx="18" fill="#141c38" stroke="url(#${id}b)" stroke-width="4"/>
      <rect x="104" y="146" width="112" height="16" rx="8" fill="#ff6b6b"/><rect x="104" y="120" width="112" height="16" rx="8" fill="#f2b14b"/>
      <rect x="104" y="94" width="112" height="16" rx="8" fill="url(#${id}b)"/>
      ${sparkles(id)}`, id, 'Almacenamiento lleno');
  },
};
