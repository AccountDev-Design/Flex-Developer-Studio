// Pasarela con Flex Account (modo remote) y validacion de la configuracion.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RemoteAccountGateway, sha256hex } from '../src/account/gateway.js';
import { loadConfig } from '../src/config.js';
import { startCloud } from '../src/server.js';
import { makeClient, sha256 } from './helpers.js';

// Un Flex Account de mentira que habla el contrato de introspeccion.
function fakeAccount() {
  const state = { calls: 0, down: false, devices: new Map(), sessions: new Map(), lastBody: null, lastAuth: null };
  const server = createServer(async (req, res) => {
    state.calls++;
    let raw = '';
    for await (const c of req) raw += c;
    state.lastAuth = req.headers.authorization;
    state.lastBody = JSON.parse(raw || '{}');
    if (state.down) { res.statusCode = 502; res.end('bad gateway'); return; }
    if (req.headers.authorization !== 'Bearer service-key-123456789012345678') { res.statusCode = 401; res.end(); return; }
    const b = state.lastBody;
    let out = { active: false, reason: 'auth_required' };
    if (b.kind === 'device') out = state.devices.get(b.tokenHash) || { active: false, reason: 'device_revoked' };
    if (b.kind === 'session') {
      const m = /flex_session=([^;]+)/.exec(b.cookie || '');
      out = (m && state.sessions.get(m[1])) || { active: false, reason: 'auth_required' };
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(out));
  });
  return { state, server };
}

describe('pasarela remota de Flex Account', () => {
  let fa, url;
  before(async () => {
    fa = fakeAccount();
    await new Promise((r) => fa.server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${fa.server.address().port}/api/internal/introspect`;
  });
  after(() => fa.server.close());

  it('pregunta por la HUELLA del dispositivo, con la clave de servicio', async () => {
    const token = 'x'.repeat(43);
    fa.state.devices.set(sha256hex(token), { active: true, account: { id: 'acc_1', flexAddress: 'ana@flex', displayName: 'Ana' }, device: { id: 'dev_1', label: 'P4' } });
    const gw = new RemoteAccountGateway({ introspectUrl: url, serviceKey: 'service-key-123456789012345678', cacheMs: 30000, timeoutMs: 2000 });
    const r = await gw.resolveDevice(sha256hex(token));
    assert.equal(r.active, true);
    assert.equal(r.account.id, 'acc_1');
    assert.deepEqual(fa.state.lastBody, { kind: 'device', tokenHash: sha256hex(token) });
    assert.ok(!JSON.stringify(fa.state.lastBody).includes(token), 'la credencial en claro no sale');
    assert.equal(fa.state.lastAuth, 'Bearer service-key-123456789012345678');
  });

  it('cachea lo positivo, poco lo negativo, y aguanta un corte breve', async () => {
    let t = 1000;
    const gw = new RemoteAccountGateway({ introspectUrl: url, serviceKey: 'service-key-123456789012345678', cacheMs: 30000, timeoutMs: 2000 }, { now: () => t });
    fa.state.sessions.set('abc', { active: true, account: { id: 'acc_2', flexAddress: 'bea@flex' } });
    const n0 = fa.state.calls;
    await gw.resolveSession({ cookie: 'flex_session=abc' });
    await gw.resolveSession({ cookie: 'flex_session=abc' });
    assert.equal(fa.state.calls - n0, 1, 'una sola pregunta en 30 s');
    fa.state.down = true;
    t += 31000;
    const stale = await gw.resolveSession({ cookie: 'flex_session=abc' });
    assert.equal(stale.active, true, 'si Flex Account cae un momento, una sesion conocida sigue valiendo');
    t += 6 * 60 * 1000;
    await assert.rejects(gw.resolveSession({ cookie: 'flex_session=abc' }), (e) => e.code === 'account_unavailable' && e.status === 503);
    await assert.rejects(gw.resolveSession({ cookie: 'flex_session=desconocida' }), (e) => e.code === 'account_unavailable',
      'caido y sin cache: 503, nunca "no autenticado"');
    fa.state.down = false;
    const neg = await gw.resolveSession({ cookie: 'flex_session=nueva' });
    assert.equal(neg.active, false);
    fa.state.sessions.set('nueva', { active: true, account: { id: 'acc_3' } });
    t += 6000;
    assert.equal((await gw.resolveSession({ cookie: 'flex_session=nueva' })).active, true, 'lo negativo caduca en segundos');
  });

  it('respuesta con forma inesperada: 503, no se adivina una cuenta', async () => {
    fa.state.sessions.set('rara', { active: true, account: { id: '../../etc' } });
    const gw = new RemoteAccountGateway({ introspectUrl: url, serviceKey: 'service-key-123456789012345678', cacheMs: 0, timeoutMs: 2000 });
    await assert.rejects(gw.resolveSession({ cookie: 'flex_session=rara' }), (e) => e.code === 'account_unavailable');
  });

  it('Flex Cloud entero contra el Flex Account remoto', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'flex-cloud-remote-'));
    const cloud = await startCloud({
      env: { FLEX_ACCOUNT_MODE: 'remote', FLEX_ACCOUNT_INTROSPECT_URL: url, FLEX_ACCOUNT_SERVICE_KEY: 'service-key-123456789012345678', FLEX_CLOUD_PORT: '0' },
      overrides: { dataDir: dir, secret: 's'.repeat(40), log: () => {} },
    });
    try {
      const base = `http://127.0.0.1:${cloud.port}`;
      fa.state.sessions.set('web1', { active: true, account: { id: 'acc_web', flexAddress: 'carla@flex', displayName: 'Carla', plan: 'plus' } });
      const web = makeClient(base, { cookie: 'flex_session=web1', 'x-flex-cloud': '1' });
      const me = await web.get('/me');
      assert.equal(me.status, 200);
      assert.equal(me.data.account.flexAddress, 'carla@flex');
      assert.equal(me.data.quota.totalBytes, 10 * 1024 ** 3, 'el plan lo dice Flex Account');
      const token = 'y'.repeat(43);
      fa.state.devices.set(sha256(token), { active: true, account: { id: 'acc_web', flexAddress: 'carla@flex' }, device: { id: 'p4', label: 'P4' } });
      const p4 = makeClient(base, { authorization: `Bearer ${token}` });
      const f = await p4.upload('desde-el-p4.txt', Buffer.from('hola'));
      assert.equal(f.status, 200);
      const list = (await web.get('/files')).data.items.map((i) => i.name);
      assert.deepEqual(list, ['desde-el-p4.txt'], 'la web y el P4 ven la MISMA nube');
      fa.state.down = true;
      const other = makeClient(base, { cookie: 'flex_session=otra', 'x-flex-cloud': '1' });
      const r = await other.get('/me');
      assert.equal(r.status, 503);
      assert.equal(r.data.error.code, 'account_unavailable');
      fa.state.down = false;
    } finally {
      await cloud.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('configuracion', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flex-cloud-cfg-'));
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('la cuota sale de los planes, no del codigo', () => {
    const c = loadConfig({ FLEX_ACCOUNT_MODE: 'dev', FLEX_CLOUD_PLANS: '{"free": 1234, "grande": 99999}' }, { dataDir: dir });
    assert.deepEqual(c.plans, { free: 1234, grande: 99999 });
    const d = loadConfig({ FLEX_ACCOUNT_MODE: 'dev' }, { dataDir: dir });
    assert.equal(d.plans.free, 5 * 1024 ** 3);
    assert.equal(d.plans.plus, 10 * 1024 ** 3);
    assert.equal(d.plans.pro, 50 * 1024 ** 3);
    assert.equal(d.plans.max, 100 * 1024 ** 3);
  });

  it('produccion: sin modo dev, con secreto y con Flex Account por https', () => {
    assert.throws(() => loadConfig({ NODE_ENV: 'production', FLEX_ACCOUNT_MODE: 'dev', FLEX_CLOUD_SECRET: 'x'.repeat(40) }, { dataDir: dir }), /no esta permitido/);
    assert.throws(() => loadConfig({ NODE_ENV: 'production', FLEX_ACCOUNT_INTROSPECT_URL: 'https://a/b', FLEX_ACCOUNT_SERVICE_KEY: 'k'.repeat(30) }, { dataDir: dir }), /FLEX_CLOUD_SECRET/);
    assert.throws(() => loadConfig({ NODE_ENV: 'production', FLEX_CLOUD_SECRET: 'x'.repeat(40), FLEX_ACCOUNT_INTROSPECT_URL: 'http://a/b', FLEX_ACCOUNT_SERVICE_KEY: 'k'.repeat(30) }, { dataDir: dir }), /https/);
    assert.throws(() => loadConfig({ NODE_ENV: 'production', FLEX_CLOUD_SECRET: 'x'.repeat(40), FLEX_ACCOUNT_INTROSPECT_URL: 'https://a/b' }, { dataDir: dir }), /SERVICE_KEY/);
    const ok = loadConfig({ NODE_ENV: 'production', FLEX_CLOUD_SECRET: 'x'.repeat(40), FLEX_ACCOUNT_INTROSPECT_URL: 'https://a/b', FLEX_ACCOUNT_SERVICE_KEY: 'k'.repeat(30) }, { dataDir: dir });
    assert.equal(ok.account.mode, 'remote');
    assert.equal(ok.account.devLogin, false);
  });

  it('planes mal escritos se rechazan con un motivo', () => {
    assert.throws(() => loadConfig({ FLEX_ACCOUNT_MODE: 'dev', FLEX_CLOUD_PLANS: '{"free": -1}' }, { dataDir: dir }), /no valida/);
    assert.throws(() => loadConfig({ FLEX_ACCOUNT_MODE: 'dev', FLEX_CLOUD_PLANS: 'nope' }, { dataDir: dir }), /JSON/);
    assert.throws(() => loadConfig({ FLEX_ACCOUNT_MODE: 'dev', FLEX_CLOUD_DEFAULT_PLAN: 'oro' }, { dataDir: dir }), /no existe/);
  });
});
