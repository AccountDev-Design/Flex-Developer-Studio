// Flex Cloud Web en un Chromium DE VERDAD contra un Flex Cloud de verdad
// (modo dev). Necesita Playwright (local o global); sin el, se dice que se
// omite y se sale con 0, nunca se da por pasada en silencio.
//
//   npm run test:e2e
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startCloud } from '../../src/server.js';

const require = createRequire(import.meta.url);
function loadPlaywright() {
  try { return require('playwright'); } catch { /* sigue */ }
  try { return require(join(execSync('npm root -g', { encoding: 'utf8' }).trim(), 'playwright')); } catch { return null; }
}
const pw = loadPlaywright();
if (!pw) { console.log('=== e2e de Flex Cloud Web OMITIDA: no hay Playwright ==='); process.exit(0); }

let checks = 0, fails = 0;
const ok = (cond, msg) => { checks++; if (!cond) { fails++; console.log(`  FALLO: ${msg}`); } else console.log(`  ok  ${msg}`); };
const sha = (b) => createHash('sha256').update(b).digest('hex');
function bytesOf(size, seed) { const b = Buffer.alloc(size); let x = seed; for (let i = 0; i < size; i++) { x = (x * 1103515245 + 12345) >>> 0; b[i] = x >>> 24; } return b; }

const dir = mkdtempSync(join(tmpdir(), 'flex-cloud-e2e-'));
const cloud = await startCloud({ env: { FLEX_ACCOUNT_MODE: 'dev', FLEX_CLOUD_DEV_LOGIN: '1', FLEX_CLOUD_PORT: '0' }, overrides: { dataDir: dir, secret: 'e'.repeat(40), log: () => {} } });
const base = `http://127.0.0.1:${cloud.port}/`;
const launch = {};
try { execSync('ls /opt/pw-browsers/chromium*', { stdio: 'ignore' }); } catch { /* ruta por defecto de Playwright */ }
const browser = await pw.chromium.launch(launch);
const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 }, acceptDownloads: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
// 401 = la comprobacion de sesion antes de entrar; ERR_INTERNET_DISCONNECTED =
// el corte de red que provoca la propia prueba.
page.on('console', (m) => { if (m.type() === 'error' && !/401 \(Unauthorized\)|ERR_INTERNET_DISCONNECTED/.test(m.text())) errors.push(m.text()); });
const api = async (path, init = {}) => page.evaluate(async ([p, i]) => { const r = await fetch('/api/cloud' + p, { ...i, headers: { 'x-flex-cloud': '1', 'content-type': 'application/json', ...(i.headers || {}) } }); return r.json(); }, [path, init]);
const tiles = () => page.$$eval('.tile .name', (n) => n.map((x) => x.textContent));

try {
  console.log('=== Flex Cloud Web · Chromium ===');
  await page.goto(base);
  await page.waitForSelector('.gate-card');
  ok(await page.isVisible('text=Iniciar sesión con Flex Account'), 'acceso: se entra con Flex Account (sin login propio)');
  await page.click('[data-dev] button');
  await page.waitForSelector('.app');
  await page.waitForSelector('.empty');
  ok(await page.isVisible('text=Te damos la bienvenida a tu Flex Cloud'), 'estado vacio con ilustracion y bienvenida');
  ok((await page.textContent('[data-quota]')).includes('5 GB'), 'cuota de 5 GB visible');

  // ---- subir archivos con nombres Unicode (y una imagen real para la miniatura)
  const png = Buffer.from(await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 400; c.height = 300; const x = c.getContext('2d'); x.fillStyle = '#9b6bff'; x.fillRect(0, 0, 400, 300); return c.toDataURL('image/png').split(',')[1]; }), 'base64');
  const doc = bytesOf(150_000, 7);
  await page.setInputFiles('[data-pick]', [
    { name: 'Atardecer ñandú 🌅.png', mimeType: 'image/png', buffer: png },
    { name: 'Informe técnico Año 2026.pdf', mimeType: 'application/pdf', buffer: doc },
  ]);
  await page.waitForFunction(() => document.querySelectorAll('.tile').length >= 2, null, { timeout: 15000 });
  const names = await tiles();
  ok(names.includes('Atardecer ñandú 🌅.png') && names.includes('Informe técnico Año 2026.pdf'), 'nombres con tildes, ñ y emoji intactos');
  await page.waitForSelector('.tile img.ok', { timeout: 15000 });
  ok(true, 'miniatura generada en el navegador y servida aparte');
  const list = await api('/files');
  const pdf = list.items.find((i) => i.name === 'Informe técnico Año 2026.pdf');
  ok(pdf && pdf.sha256 === sha(doc) && pdf.size === doc.length, 'el original se guardo byte a byte (SHA-256)');
  const pngItem = list.items.find((i) => i.kind === 'photo');
  ok(pngItem.sha256 === sha(png), 'la imagen original NO se recomprimio (la miniatura es otro objeto)');

  // ---- carpetas
  await page.click('[data-act="new-folder"]');
  await page.fill('.dialog input', 'Vacaciones de Año Nuevo');
  await page.press('.dialog input', 'Enter');
  await page.waitForSelector('.tile.folder');
  await page.click('.tile.folder');
  await page.waitForSelector('.crumbs button:has-text("Vacaciones de Año Nuevo")');
  ok(true, 'navegar a una carpeta con migas de pan');
  await page.setInputFiles('[data-pick]', [{ name: 'dentro.txt', mimeType: 'text/plain', buffer: Buffer.from('hola') }]);
  await page.waitForFunction(() => [...document.querySelectorAll('.tile .name')].some((n) => n.textContent === 'dentro.txt'));
  ok(true, 'subir dentro de una carpeta');
  await page.click('.crumbs button:has-text("Mi nube")');
  await page.waitForSelector('.tile.folder');

  // ---- busqueda
  await page.fill('[data-search]', 'ÑANDÚ');
  await page.waitForFunction(() => location.hash.startsWith('#/search'));
  await page.waitForFunction(() => document.querySelectorAll('.tile').length === 1);
  ok((await tiles())[0] === 'Atardecer ñandú 🌅.png', 'busqueda sin distinguir mayusculas ni tildes de caso');
  await page.fill('[data-search]', 'no-existe-nada');
  await page.waitForSelector('text=Sin resultados');
  ok(true, 'busqueda sin resultados con ilustracion');
  await page.fill('[data-search]', '');
  await page.waitForFunction(() => location.hash === '#/' || location.hash === '');
  await page.waitForSelector('.tile.folder');

  // ---- renombrar por el menu contextual
  await page.click('.tile:has-text("Informe técnico") .more', { force: true });
  await page.click('.menu button:has-text("Cambiar nombre")');
  await page.fill('.dialog input', 'Informe final 2026.pdf');
  await page.press('.dialog input', 'Enter');
  await page.waitForFunction(() => [...document.querySelectorAll('.tile .name')].some((n) => n.textContent === 'Informe final 2026.pdf'));
  ok(true, 'renombrar desde el menu contextual');

  // ---- papelera: deshacer, restaurar
  await page.click('.tile:has-text("Informe final") .more', { force: true });
  await page.click('.menu button:has-text("Mover a la papelera")');
  await page.waitForSelector('.toast button:has-text("Deshacer")');
  ok(!(await tiles()).includes('Informe final 2026.pdf'), 'a la papelera: desaparece de la vista');
  await page.click('.toast button:has-text("Deshacer")');
  await page.waitForFunction(() => [...document.querySelectorAll('.tile .name')].some((n) => n.textContent === 'Informe final 2026.pdf'));
  ok(true, 'deshacer devuelve el archivo');
  await page.click('.tile:has-text("Informe final") .more', { force: true });
  await page.click('.menu button:has-text("Mover a la papelera")');
  await page.click('[data-nav] a[data-v="trash"]');
  await page.waitForFunction(() => [...document.querySelectorAll('.tile .name')].some((n) => n.textContent === 'Informe final 2026.pdf'));
  const quotaTrash = await page.textContent('[data-quota]');
  ok(/en la papelera/.test(quotaTrash), 'la cuota dice cuanto ocupa la papelera');
  await page.click('.tile:has-text("Informe final") .more', { force: true });
  await page.click('.menu button:has-text("Restaurar")');
  await page.waitForSelector('text=La papelera está vacía');
  ok(true, 'restaurar desde la papelera');

  // ---- video por rangos
  await page.goto(base + '#/');
  await page.waitForSelector('.tile');
  const vid = bytesOf(2_000_000, 3);
  await page.setInputFiles('[data-pick]', [{ name: 'clip.mp4', mimeType: 'video/mp4', buffer: vid }]);
  await page.waitForFunction(() => [...document.querySelectorAll('.tile .name')].some((n) => n.textContent === 'clip.mp4'), null, { timeout: 20000 });
  const ranged = page.waitForResponse((r) => r.url().includes('/download/') && r.status() === 206, { timeout: 10000 }).catch(() => null);
  await page.click('.tile:has-text("clip.mp4")');
  await page.waitForSelector('.viewer video');
  ok(!!(await ranged), 'el reproductor pide el video por rangos (206), no entero');
  await page.keyboard.press('Escape');

  // ---- corte de red a mitad de una subida
  const big = bytesOf(20 * 1024 * 1024 + 333, 11);                // 3 partes de 8 MB
  await page.setInputFiles('[data-pick]', [{ name: 'grande sin red.bin', mimeType: 'application/octet-stream', buffer: big }]);
  await page.waitForFunction(() => /Subiendo/.test(document.querySelector('[data-transfers]')?.innerText || ''), null, { timeout: 15000 });
  await ctx.setOffline(true);
  await page.waitForFunction(() => /Esperando conexión|Reintentando/.test(document.querySelector('[data-transfers]')?.innerText || ''), null, { timeout: 20000 });
  ok(true, 'sin red: la subida espera (no falla ni se pierde)');
  await page.waitForTimeout(1500);
  await ctx.setOffline(false);
  await page.waitForFunction(() => [...document.querySelectorAll('.tile .name')].some((n) => n.textContent === 'grande sin red.bin'), null, { timeout: 60000 });
  const gf = (await api('/files?view=search&q=' + encodeURIComponent('grande sin red'))).items[0];
  ok(gf && gf.sha256 === sha(big), 'al volver la red termina y el archivo es identico');

  // ---- recargar la pagina a mitad de una subida y reanudar
  // Archivo REAL en disco: el navegador comprueba que es el mismo (nombre,
  // tamano y fecha de modificacion) antes de continuar.
  const huge = bytesOf(40 * 1024 * 1024 + 77, 21);                // 5 partes
  const hugePath = join(dir, 'reanudar.bin');
  writeFileSync(hugePath, huge);
  page.on('dialog', (d) => d.accept());                           // "salir con una subida en curso"
  // Subida lenta (8 MB/s) para recargar con partes ya recibidas y otras pendientes.
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 5, downloadThroughput: -1, uploadThroughput: 8 * 1024 * 1024 });
  await page.setInputFiles('[data-pick]', hugePath);
  let partsBefore = 0;
  for (let i = 0; i < 300 && partsBefore < 1; i++) {
    const u = (await api('/uploads')).uploads.find((x) => x.name === 'reanudar.bin');
    partsBefore = u ? u.receivedParts.length : 0;
    if (partsBefore < 1) await page.waitForTimeout(50);
  }
  await page.reload();
  await page.waitForSelector('.xfer:has-text("Vuelve a elegir el archivo")', { timeout: 15000 });
  const before = (await api('/uploads')).uploads.find((u) => u.name === 'reanudar.bin');
  ok(before && before.receivedParts.length >= 1 && before.receivedParts.length < before.totalParts,
     `tras recargar, el servidor conserva ${before?.receivedParts.length} de ${before?.totalParts} partes`);
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  const chooser = page.waitForEvent('filechooser');
  await page.click('.xfer [data-act="xfer-attach"]');
  await (await chooser).setFiles(hugePath);
  await page.waitForFunction(() => [...document.querySelectorAll('.tile .name')].some((n) => n.textContent === 'reanudar.bin'), null, { timeout: 60000 });
  const rf = (await api('/files?view=search&q=reanudar')).items[0];
  ok(rf && rf.sha256 === sha(huge), 'continuo donde iba y el resultado es identico');

  // ---- descarga
  await page.goto(base + '#/recent');
  await page.waitForSelector('.tile');
  await page.click('.tile:has-text("clip.mp4") .more', { force: true });
  const dlP = page.waitForEvent('download', { timeout: 20000 });
  await page.click('.menu button:has-text("Descargar")');
  const dl = await dlP;
  const path = await dl.path();
  ok(sha(readFileSync(path)) === sha(vid), 'descarga identica al original');

  // ---- movil
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(base + '#/');
  await page.waitForSelector('.tile');
  ok(await page.isVisible('.bottom-nav'), 'movil: barra de navegacion inferior');
  ok(await page.isVisible('.fab'), 'movil: boton flotante de subir');
  const overflow = await page.evaluate(() => document.querySelector('.content').scrollWidth > document.querySelector('.content').clientWidth + 1);
  ok(!overflow, 'movil: sin desplazamiento horizontal');

  // ---- sin crypto.subtle (la web abierta por http:// desde la red local)
  // El navegador solo ofrece crypto.subtle en https o en localhost: en otra
  // pestana de la misma sesion se quita y se sube un archivo de dos partes. Las
  // huellas las calcula sha256.js y el servidor tiene que aceptarlas.
  const lan = await ctx.newPage();
  lan.on('pageerror', (e) => errors.push(e.message));
  await lan.addInitScript(() => Object.defineProperty(Crypto.prototype, 'subtle', { get: () => undefined, configurable: true }));
  await lan.goto(base + '#/');
  await lan.waitForSelector('.app');
  ok(await lan.evaluate(() => typeof crypto.subtle) === 'undefined', 'sin subtle: la pestana no tiene crypto.subtle');
  const plain = bytesOf(8 * 1024 * 1024 + 4321, 11);
  await lan.setInputFiles('[data-pick]', [{ name: 'sin subtle.bin', mimeType: 'application/octet-stream', buffer: plain }]);
  let plainItem = null;
  for (let i = 0; i < 120 && !plainItem; i++) {
    plainItem = (await api('/files')).items.find((x) => x.name === 'sin subtle.bin');
    if (!plainItem) await lan.waitForTimeout(250);
  }
  ok(plainItem && plainItem.size === plain.length && plainItem.sha256 === sha(plain), 'sin subtle: subida de dos partes aceptada y byte a byte');
  await lan.close();

  ok(errors.length === 0, `sin errores en la consola${errors.length ? ': ' + errors.join(' | ') : ''}`);
} catch (e) {
  fails++;
  console.log(`  FALLO: ${e.message}`);
  await page.screenshot({ path: join(dir, 'fallo.png') }).catch(() => {});
} finally {
  await browser.close();
  await cloud.close();
  if (!fails) rmSync(dir, { recursive: true, force: true });
  else console.log(`  (captura y datos en ${dir})`);
}
console.log(`=== ${checks} comprobaciones, ${fails} fallos ===`);
process.exit(fails ? 1 : 0);
