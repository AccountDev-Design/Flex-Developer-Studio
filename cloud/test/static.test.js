// Ruta publica de la web: Flex Cloud se abre en /cloud/ (la ruta que documenta
// docs/FLEX_ACCOUNT_INTEGRATION.md y a la que apunta el enlace de Flex Account),
// y tambien en la raiz del servicio. /cloud sin barra redirige: los enlaces
// relativos de index.html (css/, js/) solo resuelven bien con la barra final.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import { boot } from './helpers.js';

describe('web: ruta directa /cloud/', () => {
  let ctx;
  before(async () => { ctx = await boot(); });
  after(async () => { await ctx.cleanup(); });
  const get = (path, init = {}) => fetch(`${ctx.base}${path}`, { redirect: 'manual', ...init });

  it('/cloud redirige a /cloud/ (conserva la consulta)', async () => {
    for (const [from, to] of [['/cloud', '/cloud/'], ['/cloud?x=1', '/cloud/?x=1']]) {
      const r = await get(from);
      assert.equal(r.status, 301, from);
      assert.equal(r.headers.get('location'), to);
    }
  });

  it('/cloud/ sirve la web y sus estaticos (los relativos resuelven bajo /cloud/)', async () => {
    const page = await get('/cloud/');
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.match(await page.text(), /<title>Flex Cloud<\/title>/);
    for (const [path, type] of [['/cloud/css/app.css', /text\/css/], ['/cloud/js/app.js', /javascript/], ['/cloud/favicon.svg', /svg/]]) {
      const r = await get(path);
      assert.equal(r.status, 200, path);
      assert.match(r.headers.get('content-type'), type, path);
      await r.arrayBuffer();
    }
  });

  it('en la raiz del servicio sigue funcionando igual', async () => {
    const r = await get('/');
    assert.equal(r.status, 200);
    assert.match(await r.text(), /<title>Flex Cloud<\/title>/);
    assert.equal((await get('/js/app.js')).status, 200);
  });

  it('no se sale de la carpeta de la web ni acepta rutas rotas', async () => {
    for (const p of ['/cloud/../src/config.js', '/cloud/..%2fsrc/config.js', '/cloud/%2e%2e/src/config.js']) {
      const r = await get(p);
      assert.ok(r.status === 404 || r.status === 400 || r.status === 200 && /<title>Flex Cloud/.test(await r.clone().text()), `${p} -> ${r.status}`);
      assert.doesNotMatch(await r.text(), /FLEX_CLOUD_PORT|export function loadConfig/, p);
    }
    assert.equal((await get('/cloud/%')).status, 400);
    assert.equal((await get('/cloud/', { method: 'POST' })).status, 405);
    assert.equal((await get('/cloud/js/no-existe.js')).status, 404);
  });

  it('la API no se ve afectada: /api/cloud/health sigue ahi', async () => {
    const r = await get('/api/cloud/health');
    assert.equal(r.status, 200);
  });

  it('la web trae la ayuda corta (seis temas) y el boton en barra lateral y superior', () => {
    const js = readFileSync(new URL('../web/js/app.js', import.meta.url), 'utf8');
    assert.equal((js.match(/data-act="help"/g) || []).length, 2);
    assert.match(js, /case 'help': helpGuide\(\)/);
    const body = js.slice(js.indexOf('function helpGuide'), js.indexOf('function deviceInfo'));
    assert.equal((body.match(/<details/g) || []).length, 6);
    for (const t of ['Subir archivos', 'Carpetas', 'Descargar', 'Verlo desde Flex OS', 'almacenamiento', 'desvincula']) assert.match(body, new RegExp(t), t);
    assert.ok(body.length < 3000, 'la guia se queda corta');
  });
});
