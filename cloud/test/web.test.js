// La web de Flex Cloud ante una SESION PERDIDA (Flex Account deja de reconocerla:
// se cerro en otra pestana, caduco o se desvinculo).
//
// Existe por un fallo real: el 401 solo se miraba en el arranque y en el
// listado. `refreshQuota` se tragaba cualquier error, las acciones solo
// ensenaban un aviso y las transferencias fabrican sus propios ApiError, asi que
// la web se quedaba "conectada", con la cuota y los archivos viejos, hasta
// recargar a mano. El aviso sale ahora del constructor de ApiError (api.js).
//
// api.js es un modulo de navegador: aqui corre en Node con `document`,
// `navigator` y `fetch` simulados; la ultima prueba lo apunta al servidor REAL.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { boot, webClient } from './helpers.js';

const realFetch = globalThis.fetch;
globalThis.document = { querySelector: () => null };
Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true });

const { api, ApiError, onAuthLost, resetAuthLost } = await import('../web/js/api.js');
const tick = () => new Promise((r) => setTimeout(r, 0));

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
const lost = (code) => jsonResponse(401, { ok: false, error: { code, message: 'x' } });

describe('web: sesion perdida', () => {
  let seen;
  before(() => { onAuthLost((e) => seen.push(e)); });
  after(() => { globalThis.fetch = realFetch; });
  const reset = () => { seen = []; resetAuthLost(); };

  it('un 401 de CUALQUIER peticion se anuncia, con su codigo', async () => {
    reset();
    for (const code of ['auth_required', 'token_expired', 'device_revoked']) {
      reset();
      globalThis.fetch = async () => lost(code);
      await assert.rejects(api.quota(), (e) => e instanceof ApiError && e.status === 401 && e.code === code && e.authLost);
      await tick();
      assert.equal(seen.length, 1, `${code}: un solo aviso`);
      assert.equal(seen[0].code, code);
    }
  });

  it('se anuncia UNA vez aunque fallen varias peticiones seguidas', async () => {
    reset();
    globalThis.fetch = async () => lost('auth_required');
    await Promise.allSettled([api.me(), api.quota(), api.list({}), api.uploads()]);
    await tick();
    assert.equal(seen.length, 1, 'cuatro 401 seguidos = un aviso (no cuatro pantallas de acceso)');
  });

  it('tras una sesion nueva (resetAuthLost) puede volver a anunciarse', async () => {
    reset();
    globalThis.fetch = async () => lost('auth_required');
    await assert.rejects(api.me()); await tick();
    resetAuthLost();
    await assert.rejects(api.me()); await tick();
    assert.equal(seen.length, 2);
  });

  it('un ApiError(401) fabricado fuera de request() tambien avisa (partes por XHR, descargas)', async () => {
    reset();
    const e = new ApiError(401, 'http_401', 'Flex Cloud respondió 401.');
    await tick();
    assert.equal(seen.length, 1);
    assert.equal(seen[0], e);
  });

  it('lo que NO es una sesion perdida no avisa: red caida, 5xx, 403, 404 y 429', async () => {
    reset();
    globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
    await assert.rejects(api.me(), (e) => e.offline);
    for (const st of [500, 503, 403, 404, 429]) {
      globalThis.fetch = async () => jsonResponse(st, { ok: false, error: { code: 'x', message: 'x' } });
      await assert.rejects(api.me());
    }
    await tick();
    assert.equal(seen.length, 0);
  });

  it('un manejador que falla no rompe el error que se lanza', async () => {
    reset();
    onAuthLost(() => { throw new Error('la interfaz fallo'); });
    globalThis.fetch = async () => lost('auth_required');
    await assert.rejects(api.me(), (e) => e.status === 401);
    await tick();
    onAuthLost((e) => seen.push(e));                      // se deja el de las demas pruebas
  });
});

describe('web: contra el servidor REAL, revocar la sesion se nota en la SIGUIENTE peticion', () => {
  let t, web, cookie, seen;
  before(async () => {
    t = await boot();
    web = await webClient(t.base);
    cookie = web.headers.cookie;
    // api.js usa rutas relativas y la cookie del navegador: aqui se simulan.
    globalThis.fetch = (u, init = {}) => realFetch(t.base + u, { ...init, headers: { ...init.headers, cookie } });
    seen = [];
    onAuthLost((e) => seen.push(e));
    resetAuthLost();
  });
  after(async () => { globalThis.fetch = realFetch; await t.cleanup(); });

  it('con la sesion viva, todo normal (y sin avisos)', async () => {
    const me = await api.me();
    assert.equal(me.account.flexAddress, 'ana@flex');
    assert.equal((await api.quota()).quota.totalBytes > 0, true);
    await tick();
    assert.equal(seen.length, 0);
  });

  it('se cierra la sesion en Flex Account: la cuota (que se tragaba el error) y el listado se enteran', async () => {
    const token = decodeURIComponent(cookie.split('=').slice(1).join('=').split(';')[0]);
    t.cloud.gateway.destroySession(token);
    await assert.rejects(api.quota(), (e) => e.status === 401 && e.code === 'auth_required');
    await assert.rejects(api.list({ parentId: 'root' }), (e) => e.status === 401);
    await tick();
    assert.equal(seen.length, 1, 'una sola pantalla de acceso');
    assert.equal(seen[0].code, 'auth_required');
  });
});
