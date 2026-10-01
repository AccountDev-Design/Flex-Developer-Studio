// API de Flex Cloud de extremo a extremo: HTTP real, SQLite real y disco real.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, webClient, deviceClient, makeClient, sha256, pattern, interruptedPart } from './helpers.js';

describe('identidad y seguridad', () => {
  let t, ana, bea;
  before(async () => { t = await boot(); ana = await webClient(t.base, 'ana@flex', 'Ana'); bea = await webClient(t.base, 'bea@flex', 'Bea'); });
  after(async () => t.cleanup());

  it('sin sesion: 401 auth_required, nunca datos', async () => {
    const anon = makeClient(t.base, {});
    const r = await anon.get('/me');
    assert.equal(r.status, 401);
    assert.equal(r.data.error.code, 'auth_required');
    assert.equal((await anon.get('/files')).status, 401);
  });

  it('la cuenta sale de Flex Account, no del cliente', async () => {
    const r = await ana.get('/me');
    assert.equal(r.status, 200);
    assert.equal(r.data.account.flexAddress, 'ana@flex');
    // Un accountId en el cuerpo o en la consulta no cambia de quien es nada.
    const f = await ana.post('/folders', { name: 'Mia', accountId: 'acc_de_otro', ownerId: 'x' });
    assert.equal(f.status, 201);
    const list = await bea.get('/files?accountId=' + encodeURIComponent(r.data.account.id));
    assert.equal(list.data.items.length, 0);
  });

  it('cuota inicial 5 GB desde la configuracion', async () => {
    const q = (await ana.get('/quota')).data.quota;
    assert.equal(q.totalBytes, 5 * 1024 ** 3);
    assert.equal(q.plan, 'free');
    assert.equal(q.availableBytes, q.totalBytes);
    assert.equal(q.state, 'ok');
  });

  it('CSRF: con cookie, sin cabecera propia o desde otro sitio se rechaza', async () => {
    const noHeader = makeClient(t.base, { cookie: ana.headers.cookie });
    assert.equal((await noHeader.post('/folders', { name: 'x' })).status, 403);
    const cross = await ana.raw('POST', '/folders', { name: 'x' }, { 'sec-fetch-site': 'cross-site' });
    assert.equal(cross.status, 403);
    const badOrigin = await ana.raw('POST', '/folders', { name: 'x' }, { origin: 'https://evil.example' });
    assert.equal(badOrigin.status, 403);
    assert.equal(badOrigin.data.error.code, 'csrf_failed');
  });

  it('dispositivo: credencial valida, revocada, caducada y basura', async () => {
    const p4 = await deviceClient(t.base, ana);
    const me = await p4.get('/me');
    assert.equal(me.status, 200);
    assert.equal(me.data.account.flexAddress, 'ana@flex');
    assert.equal(me.data.device.label, 'Flex OS Ultra');
    // La credencial del dispositivo no necesita la cabecera anti-CSRF.
    assert.equal((await p4.post('/folders', { name: 'Desde el P4' })).status, 201);

    t.cloud.gateway.setDeviceState(p4.tokenHash, 'revoked');
    const rev = await p4.get('/me');
    assert.equal(rev.status, 401);
    assert.equal(rev.data.error.code, 'device_revoked');

    const old = await deviceClient(t.base, ana);
    t.cloud.gateway.registerDevice((await ana.get('/me')).data.account.id, old.tokenHash, 'P4', t.clk.now() - 1);
    const exp = await old.get('/me');
    assert.equal(exp.status, 401);
    assert.equal(exp.data.error.code, 'token_expired');

    const junk = makeClient(t.base, { authorization: 'Bearer ' + 'A'.repeat(43) });
    assert.equal((await junk.get('/me')).status, 401);
    const weird = makeClient(t.base, { authorization: 'Bearer ../../etc/passwd' });
    assert.equal((await weird.get('/me')).status, 401);
  });

  it('aislamiento: nada de otra cuenta es alcanzable', async () => {
    const data = pattern(100_000, 7);
    const up = await ana.upload('privado.bin', data);
    assert.equal(up.status, 200);
    const fid = up.data.file.id;
    const folder = (await ana.post('/folders', { name: 'Secreta' })).data.folder;
    const pending = (await ana.post('/uploads', { name: 'a.bin', size: 10 })).data.upload;
    for (const [m, p] of [['GET', `/files/${fid}`], ['GET', `/download/${fid}`], ['GET', `/files/${fid}/thumbnail`],
                          ['DELETE', `/files/${fid}`], ['POST', `/files/${fid}/restore`], ['POST', `/files/${fid}/permanent-delete`],
                          ['PATCH', `/files/${fid}`], ['POST', `/files/${fid}/link`], ['GET', `/folders/${folder.id}`],
                          ['GET', `/files?parentId=${folder.id}`], ['DELETE', `/folders/${folder.id}`],
                          ['GET', `/uploads/${pending.uploadId}`], ['POST', `/uploads/${pending.uploadId}/complete`],
                          ['DELETE', `/uploads/${pending.uploadId}`]]) {
      const r = await bea.raw(m, p, m === 'GET' || m === 'DELETE' ? undefined : { name: 'x' });
      assert.equal(r.status, 404, `${m} ${p} debe dar 404 a otra cuenta`);
    }
    const part = await bea.putPart(pending.uploadId, 1, Buffer.alloc(10));
    assert.equal(part.status, 404);
    // Y sigue intacto para su duena.
    const dl = await ana.get(`/download/${fid}`);
    assert.equal(sha256(dl.data), sha256(data));
  });
});

describe('carpetas y nombres', () => {
  let t, ana;
  before(async () => { t = await boot(); ana = await webClient(t.base); });
  after(async () => t.cleanup());

  it('nombres con tildes, enie, emojis, espacios, largos y sin extension', async () => {
    const names = ['Fotos de Año Nuevo', 'Canción ñandú.mp3', '🎬 Vídeos 2026', 'archivo_sin_extension', ' espacios  dobles .txt ',
                   'x'.repeat(250) + '.jpg', 'ДокУмент.pdf', '日本語のファイル.png'];
    for (const n of names) {
      const r = await ana.upload(n, Buffer.from('hola ' + n));
      assert.equal(r.status, 200, n);
      assert.equal(r.data.file.name, n.normalize('NFC').trim());
    }
    const list = (await ana.get('/files')).data.items.map((i) => i.name);
    for (const n of names) assert.ok(list.includes(n.trim()), n);
    // NFC: "n + virgulilla combinante" es el MISMO nombre que "ñ".
    const dup = await ana.post('/folders', { name: 'Fotos de Año Nuevo' });
    assert.equal(dup.status, 409);
  });

  it('nombres invalidos se rechazan con un motivo', async () => {
    for (const n of ['a/b', 'a\\b', '..', '.', '', '   ', 'x'.repeat(256), 'nul\u0000', 'tab\tx', '‮exe.txt']) {
      const r = await ana.post('/folders', { name: n });
      assert.equal(r.status, 400, JSON.stringify(n));
      assert.equal(r.data.error.code, 'name_invalid');
    }
    assert.equal((await ana.post('/folders', { name: 'é'.repeat(128) })).status, 400, '256 bytes UTF-8');
    assert.equal((await ana.post('/folders', { name: 'é'.repeat(127) })).status, 201, '254 bytes UTF-8');
  });

  it('crear, anidar, renombrar, mover y evitar ciclos', async () => {
    const a = (await ana.post('/folders', { name: 'A' })).data.folder;
    const b = (await ana.post('/folders', { name: 'B', parentId: a.id })).data.folder;
    const c = (await ana.post('/folders', { name: 'C', parentId: b.id })).data.folder;
    assert.equal((await ana.post('/folders', { name: 'b', parentId: a.id })).status, 409, 'sin distinguir mayusculas');
    const info = (await ana.get(`/folders/${c.id}`)).data.folder;
    assert.deepEqual(info.path.map((p) => p.name), ['A', 'B', 'C']);
    assert.equal((await ana.patch(`/folders/${a.id}`, { parentId: c.id })).data.error.code, 'folder_cycle');
    assert.equal((await ana.patch(`/folders/${b.id}`, { name: 'B renombrada', parentId: null })).status, 200);
    const root = (await ana.get('/files')).data.items.map((i) => i.name);
    assert.ok(root.includes('B renombrada'));
  });

  it('busqueda sin distinguir mayusculas ni con comodines', async () => {
    await ana.upload('Ñandú en el campo.jpg', Buffer.from('x'));
    await ana.upload('100%_real.txt', Buffer.from('y'));
    const s = (await ana.get('/files?view=search&q=' + encodeURIComponent('ÑAND'))).data.items.map((i) => i.name).sort();
    assert.deepEqual(s, ['Canción ñandú.mp3', 'Ñandú en el campo.jpg']);
    const pct = (await ana.get('/files?view=search&q=' + encodeURIComponent('%'))).data.items;
    assert.deepEqual(pct.map((i) => i.name), ['100%_real.txt']);
  });

  it('orden y paginacion estables', async () => {
    const f = (await ana.post('/folders', { name: 'Pagina' })).data.folder;
    for (let i = 0; i < 25; i++) await ana.upload(`f${String(i).padStart(2, '0')}.bin`, Buffer.alloc(i + 1), { parentId: f.id });
    const seen = [];
    let cursor = '';
    for (let i = 0; i < 10; i++) {
      const r = (await ana.get(`/files?parentId=${f.id}&limit=7&sort=size&order=desc${cursor ? '&cursor=' + cursor : ''}`)).data;
      seen.push(...r.items.map((x) => x.size));
      if (!r.nextCursor) break;
      cursor = r.nextCursor;
    }
    assert.equal(seen.length, 25);
    assert.deepEqual(seen, [...seen].sort((a, b) => b - a));
  });
});

describe('papelera y cuota', () => {
  let t, ana;
  before(async () => { t = await boot({ env: { FLEX_CLOUD_PLANS: JSON.stringify({ free: 1_000_000, plus: 2_000_000 }) } }); ana = await webClient(t.base); });
  after(async () => t.cleanup());

  it('la papelera conserva la cuota; borrar definitivo la libera', async () => {
    const f = (await ana.post('/folders', { name: 'Viaje' })).data.folder;
    const sub = (await ana.post('/folders', { name: 'Día 1', parentId: f.id })).data.folder;
    const a = (await ana.upload('a.jpg', pattern(100_000, 1), { parentId: f.id })).data.file;
    await ana.upload('b.jpg', pattern(50_000, 2), { parentId: sub.id });
    let q = (await ana.get('/quota')).data.quota;
    assert.equal(q.usedBytes, 150_000);

    assert.equal((await ana.del(`/folders/${f.id}`)).status, 200);
    assert.equal((await ana.get('/files')).data.items.length, 0, 'la carpeta sale de la vista');
    assert.equal((await ana.get(`/files/${a.id}`)).data.file.deletedAt > 0, true);
    q = (await ana.get('/quota')).data.quota;
    assert.equal(q.usedBytes, 150_000, 'la papelera ocupa');
    assert.equal(q.trashBytes, 150_000);
    const trash = (await ana.get('/files?view=trash')).data.items;
    assert.equal(trash.length, 1);
    assert.equal(trash[0].itemCount, 2);
    // Un hijo borrado con su carpeta no se restaura suelto.
    assert.equal((await ana.post(`/files/${a.id}/restore`)).status, 400);

    const r = await ana.post(`/folders/${f.id}/restore`);
    assert.equal(r.status, 200);
    assert.equal(r.data.restored, 4);
    assert.equal((await ana.get(`/files?parentId=${sub.id}`)).data.items.length, 1);

    await ana.del(`/folders/${f.id}`);
    const del = await ana.post(`/folders/${f.id}/permanent-delete`);
    assert.equal(del.data.freedBytes, 150_000);
    q = (await ana.get('/quota')).data.quota;
    assert.equal(q.usedBytes, 0);
    assert.equal((await ana.get(`/download/${a.id}`)).status, 404);
  });

  it('restaurar a una carpeta que ya no existe va a la raiz y no pisa nombres', async () => {
    const f = (await ana.post('/folders', { name: 'Temporal' })).data.folder;
    const x = (await ana.upload('nota.txt', Buffer.from('uno'), { parentId: f.id })).data.file;
    await ana.del(`/files/${x.id}`);
    await ana.del(`/folders/${f.id}`);
    await ana.post(`/folders/${f.id}/permanent-delete`);
    await ana.upload('nota.txt', Buffer.from('dos'));
    const r = await ana.post(`/files/${x.id}/restore`);
    assert.equal(r.status, 200);
    assert.equal(r.data.item.parentId, null);
    assert.equal(r.data.item.name, 'nota (1).txt');
    const both = (await ana.get('/files?view=search&q=nota')).data.items.map((i) => i.name).sort();
    assert.deepEqual(both, ['nota (1).txt', 'nota.txt']);
    await ana.post('/trash/empty');
  });

  it('no se puede superar la cuota, ni con subidas simultaneas', async () => {
    const q0 = (await ana.get('/quota')).data.quota;
    const big = await ana.post('/uploads', { name: 'grande.bin', size: q0.availableBytes + 1 });
    assert.equal(big.status, 507);
    assert.equal(big.data.error.code, 'quota_exceeded');
    // 10 reservas a la vez de 1/5 del hueco: entran exactamente 5.
    const each = Math.floor(q0.availableBytes / 5);
    const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => ana.post('/uploads', { name: `p${i}.bin`, size: each })));
    assert.equal(rs.filter((r) => r.status === 201).length, 5);
    assert.equal(rs.filter((r) => r.status === 507).length, 5);
    const q1 = (await ana.get('/quota')).data.quota;
    assert.equal(q1.reservedBytes, each * 5);
    assert.ok(q1.availableBytes < each);
    // Cancelar libera la reserva.
    for (const r of rs.filter((x) => x.status === 201)) await ana.del(`/uploads/${r.data.upload.uploadId}`);
    assert.equal((await ana.get('/quota')).data.quota.reservedBytes, 0);
  });

  it('una subida que caduca libera su reserva', async () => {
    const u = (await ana.post('/uploads', { name: 'abandonada.bin', size: 300_000 })).data.upload;
    assert.equal((await ana.get('/quota')).data.quota.reservedBytes, 300_000);
    t.clk.advance(73 * 3600 * 1000);
    const st = await ana.get(`/uploads/${u.uploadId}`);
    assert.equal(st.data.upload.state, 'expired');
    assert.equal((await ana.get('/quota')).data.quota.reservedBytes, 0);
    assert.equal((await ana.putPart(u.uploadId, 1, Buffer.alloc(10))).data.error.code, 'upload_expired');
  });

  it('estado de cuota: casi llena y llena', async () => {
    const q0 = (await ana.get('/quota')).data.quota;
    const r = await ana.upload('relleno.bin', pattern(Math.floor(q0.totalBytes * 0.92) - q0.usedBytes, 3), { chunkSize: 256 * 1024 });
    assert.equal(r.status, 200);
    assert.equal((await ana.get('/quota')).data.quota.state, 'low');
    const rest = (await ana.get('/quota')).data.quota.availableBytes;
    await ana.upload('ultimo.bin', pattern(rest, 4), { chunkSize: 256 * 1024 });
    const q = (await ana.get('/quota')).data.quota;
    assert.equal(q.state, 'full');
    assert.equal(q.availableBytes, 0);
    assert.equal((await ana.post('/uploads', { name: 'uno-mas.bin', size: 1 })).status, 507);
    assert.equal((await ana.post('/uploads', { name: 'vacio.txt', size: 0 })).status, 201, 'un archivo vacio cabe siempre');
  });
});

describe('subidas por partes', () => {
  let t, ana;
  before(async () => { t = await boot(); ana = await webClient(t.base); });
  after(async () => t.cleanup());

  it('normal: partes, SHA-256 por parte y del archivo, original intacto', async () => {
    const data = pattern(1_000_000, 11);
    const c = (await ana.post('/uploads', { name: 'video.avi', size: data.length, chunkSize: 128 * 1024, sha256: sha256(data) })).data.upload;
    assert.equal(c.totalParts, 8);
    assert.equal(c.chunkSize, 128 * 1024);
    for (let n = 1; n <= 8; n++) {
      const r = await ana.putPart(c.uploadId, n, data.subarray((n - 1) * c.chunkSize, n * c.chunkSize));
      assert.equal(r.status, 200);
      assert.equal(r.data.receivedCount, n);
    }
    const done = await ana.post(`/uploads/${c.uploadId}/complete`, {});
    assert.equal(done.status, 200);
    assert.equal(done.data.file.sha256, sha256(data));
    assert.equal(done.data.file.size, data.length);
    assert.equal(done.data.file.kind, 'video');
    const dl = await ana.get(`/download/${done.data.file.id}`);
    assert.ok(Buffer.compare(dl.data, data) === 0, 'los bytes descargados son los originales');
    // Completar otra vez es idempotente.
    const again = await ana.post(`/uploads/${c.uploadId}/complete`, {});
    assert.equal(again.data.file.id, done.data.file.id);
    assert.equal((await ana.get('/quota')).data.quota.usedBytes, data.length);
  });

  it('parte repetida: no se reescribe; con otro contenido: conflicto', async () => {
    const data = pattern(300_000, 12);
    const c = (await ana.post('/uploads', { name: 'r.bin', size: data.length, chunkSize: 100_000 })).data.upload;
    const p1 = data.subarray(0, 100_000);
    assert.equal((await ana.putPart(c.uploadId, 1, p1)).data.alreadyReceived, false);
    const again = await ana.putPart(c.uploadId, 1, p1);
    assert.equal(again.status, 200);
    assert.equal(again.data.alreadyReceived, true);
    const other = await ana.putPart(c.uploadId, 1, pattern(100_000, 99));
    assert.equal(other.status, 409);
    assert.equal(other.data.error.code, 'part_conflict');
    const st = (await ana.get(`/uploads/${c.uploadId}/status`)).data.upload;
    assert.deepEqual(st.receivedParts, [1]);
    assert.equal(st.receivedBytes, 100_000);
  });

  it('checksum incorrecto, tamano incorrecto y fuera de rango', async () => {
    const c = (await ana.post('/uploads', { name: 'c.bin', size: 250_000, chunkSize: 100_000 })).data.upload;
    const bad = await ana.putPart(c.uploadId, 1, pattern(100_000, 1), '0'.repeat(64));
    assert.equal(bad.status, 422);
    assert.equal(bad.data.error.code, 'checksum_mismatch');
    const short = await ana.putPart(c.uploadId, 1, pattern(99_999, 1));
    assert.equal(short.data.error.code, 'part_size_mismatch');
    const long = await ana.putPart(c.uploadId, 3, pattern(60_000, 1));
    assert.equal(long.data.error.code, 'part_size_mismatch', 'la ultima parte mide 50 000');
    assert.equal((await ana.putPart(c.uploadId, 4, pattern(10, 1))).data.error.code, 'part_out_of_range');
    assert.equal((await ana.putPart(c.uploadId, 0, pattern(10, 1))).data.error.code, 'part_out_of_range');
    const noDigest = await ana.raw('PUT', `/uploads/${c.uploadId}/parts/1`, pattern(100_000, 1), { 'content-type': 'application/octet-stream' });
    assert.equal(noDigest.status, 400);
    const st = (await ana.get(`/uploads/${c.uploadId}`)).data.upload;
    assert.deepEqual(st.receivedParts, [], 'nada de lo rechazado quedo guardado');
  });

  it('Content-Digest (RFC 9530) tambien vale', async () => {
    const data = pattern(5000, 3);
    const c = (await ana.post('/uploads', { name: 'cd.bin', size: data.length })).data.upload;
    const digest = Buffer.from(sha256(data), 'hex').toString('base64');
    const r = await ana.raw('PUT', `/uploads/${c.uploadId}/parts/1`, data, { 'content-digest': `sha-256=:${digest}:`, 'content-type': 'application/octet-stream' });
    assert.equal(r.status, 200);
  });

  it('completar con partes que faltan dice cuales; SHA del archivo distinto la descarta', async () => {
    const data = pattern(300_000, 21);
    const c = (await ana.post('/uploads', { name: 'falta.bin', size: data.length, chunkSize: 100_000 })).data.upload;
    await ana.putPart(c.uploadId, 2, data.subarray(100_000, 200_000));
    const inc = await ana.post(`/uploads/${c.uploadId}/complete`, {});
    assert.equal(inc.status, 409);
    assert.deepEqual(inc.data.error.details.missing, [1, 3]);
    await ana.putPart(c.uploadId, 1, data.subarray(0, 100_000));
    await ana.putPart(c.uploadId, 3, data.subarray(200_000));
    const reserved = (await ana.get('/quota')).data.quota.reservedBytes;
    const wrong = await ana.post(`/uploads/${c.uploadId}/complete`, { sha256: 'f'.repeat(64) });
    assert.equal(wrong.status, 422);
    assert.equal((await ana.get(`/uploads/${c.uploadId}`)).data.upload.state, 'failed');
    assert.equal((await ana.get('/quota')).data.quota.reservedBytes, reserved - data.length, 'reserva liberada');
  });

  it('reanudar: la misma clave del cliente devuelve la sesion con sus partes', async () => {
    const data = pattern(400_000, 31);
    const clientKey = 'p4:/Imagenes/IMG_0001.jpg:400000:1700000000';
    const first = (await ana.post('/uploads', { name: 'IMG_0001.jpg', size: data.length, chunkSize: 100_000, clientKey })).data.upload;
    await ana.putPart(first.uploadId, 1, data.subarray(0, 100_000));
    await ana.putPart(first.uploadId, 3, data.subarray(200_000, 300_000));
    const again = await ana.post('/uploads', { name: 'IMG_0001.jpg', size: data.length, chunkSize: 100_000, clientKey });
    assert.equal(again.status, 200);
    assert.equal(again.data.upload.resumed, true);
    assert.equal(again.data.upload.uploadId, first.uploadId);
    assert.deepEqual(again.data.upload.receivedParts, [1, 3]);
    const done = await ana.upload('IMG_0001.jpg', data, { chunkSize: 100_000, clientKey });
    assert.equal(done.status, 200);
    assert.equal(done.data.file.sha256, sha256(data));
    const list = (await ana.get('/uploads')).data.uploads;
    assert.ok(!list.find((u) => u.uploadId === first.uploadId), 'ya no figura como pendiente');
  });

  it('archivo vacio y nombre ocupado (se numera, nunca se pisa)', async () => {
    const a = await ana.upload('vacio.txt', Buffer.alloc(0));
    assert.equal(a.status, 200);
    assert.equal(a.data.file.size, 0);
    const b = await ana.upload('vacio.txt', Buffer.from('ya no'));
    assert.equal(b.data.file.name, 'vacio (1).txt');
    const fail = await ana.post('/uploads', { name: 'vacio.txt', size: 3, conflict: 'fail' });
    assert.equal(fail.status, 409);
  });

  it('cancelar: deja de aceptar partes y libera la reserva', async () => {
    const before = (await ana.get('/quota')).data.quota.reservedBytes;
    const c = (await ana.post('/uploads', { name: 'cancel.bin', size: 200_000, chunkSize: 100_000 })).data.upload;
    assert.equal((await ana.get('/quota')).data.quota.reservedBytes, before + 200_000);
    await ana.putPart(c.uploadId, 1, pattern(100_000, 5));
    const r = await ana.del(`/uploads/${c.uploadId}`);
    assert.equal(r.data.upload.state, 'aborted');
    assert.equal((await ana.putPart(c.uploadId, 2, pattern(100_000, 6))).data.error.code, 'upload_state');
    assert.equal((await ana.get('/quota')).data.quota.reservedBytes, before);
  });

  it('Wi-Fi cortado a mitad de una parte: el reintento inmediato entra (sin esperar al servidor)', async () => {
    const data = pattern(300_000, 81);
    const c = (await ana.post('/uploads', { name: 'corte-wifi.bin', size: data.length, chunkSize: 150_000, sha256: sha256(data) })).data.upload;
    const p1 = data.subarray(0, 150_000);
    await interruptedPart(t.base, ana.headers, c.uploadId, 1, p1, 70_000);
    const retry = await ana.putPart(c.uploadId, 1, p1);
    assert.equal(retry.status, 200);
    assert.equal(retry.data.alreadyReceived, false);
    // Dos conexiones con la MISMA parte a la vez: una la guarda, la otra ve que ya estaba.
    const p2 = data.subarray(150_000);
    const [a, b] = await Promise.all([ana.putPart(c.uploadId, 2, p2), ana.putPart(c.uploadId, 2, p2)]);
    assert.equal(a.status, 200); assert.equal(b.status, 200);
    assert.equal([a, b].filter((r) => r.data.alreadyReceived).length, 1);
    const done = await ana.post(`/uploads/${c.uploadId}/complete`, {});
    assert.equal(done.data.file.sha256, sha256(data));
  });

  it('el P4 sube con su credencial y partes pequenas', async () => {
    const p4 = await deviceClient(t.base, ana);
    const data = pattern(700_000, 41);
    const r = await p4.upload('Foto del P4.jpg', data, { chunkSize: 256 * 1024 });
    assert.equal(r.status, 200);
    assert.equal(r.data.file.source, 'device');
    assert.equal(r.data.file.sha256, sha256(data));
  });
});

describe('descargas, rangos, enlaces y miniaturas', () => {
  let t, ana, file, data;
  before(async () => {
    t = await boot(); ana = await webClient(t.base);
    data = pattern(500_000, 51);
    file = (await ana.upload('Película de ñandúes 🎥.avi', data, { chunkSize: 128 * 1024 })).data.file;
  });
  after(async () => t.cleanup());

  it('descarga completa con cabeceras correctas', async () => {
    const r = await ana.get(`/download/${file.id}`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('accept-ranges'), 'bytes');
    assert.equal(r.headers.get('etag'), `"${file.sha256}"`);
    assert.equal(Number(r.headers.get('content-length')), data.length);
    const cd = r.headers.get('content-disposition');
    assert.match(cd, /^attachment; filename="[\x20-\x7e]+"; filename\*=UTF-8''/);
    assert.ok(decodeURIComponent(cd.split("''")[1]) === file.name, 'nombre Unicode intacto');
    assert.equal(r.headers.get('content-security-policy'), "default-src 'none'; sandbox");
    assert.equal(sha256(r.data), file.sha256);
  });

  it('rangos: inicio, intermedio, abierto, sufijo y fuera de rango', async () => {
    const a = await ana.get(`/download/${file.id}`, { range: 'bytes=0-99' });
    assert.equal(a.status, 206);
    assert.equal(a.headers.get('content-range'), `bytes 0-99/${data.length}`);
    assert.ok(Buffer.compare(a.data, data.subarray(0, 100)) === 0);
    const b = await ana.get(`/download/${file.id}`, { range: 'bytes=123456-234567' });
    assert.ok(Buffer.compare(b.data, data.subarray(123456, 234568)) === 0);
    const c = await ana.get(`/download/${file.id}`, { range: 'bytes=499000-' });
    assert.equal(c.data.length, 1000);
    const d = await ana.get(`/download/${file.id}`, { range: 'bytes=-10' });
    assert.ok(Buffer.compare(d.data, data.subarray(data.length - 10)) === 0);
    const e = await ana.get(`/download/${file.id}`, { range: `bytes=${data.length}-` });
    assert.equal(e.status, 416);
    const big = await ana.get(`/download/${file.id}`, { range: 'bytes=499990-999999' });
    assert.equal(big.status, 206);
    assert.equal(big.data.length, 10);
  });

  it('reanudar una descarga cortada con Range + If-Range', async () => {
    const half = 222_222;
    const first = await ana.get(`/download/${file.id}`, { range: `bytes=0-${half - 1}` });
    const rest = await ana.get(`/download/${file.id}`, { range: `bytes=${half}-`, 'if-range': `"${file.sha256}"` });
    assert.equal(rest.status, 206);
    assert.equal(sha256(Buffer.concat([first.data, rest.data])), file.sha256);
    const changed = await ana.get(`/download/${file.id}`, { range: `bytes=${half}-`, 'if-range': '"otro"' });
    assert.equal(changed.status, 200, 'si el archivo cambio, se manda entero');
  });

  it('HEAD no manda cuerpo', async () => {
    const r = await ana.head(`/download/${file.id}`);
    assert.equal(r.status, 200);
    assert.equal(Number(r.headers.get('content-length')), data.length);
  });

  it('tipos activos (HTML, SVG) nunca se sirven en linea', async () => {
    const html = (await ana.upload('pagina.html', Buffer.from('<script>alert(1)</script>'))).data.file;
    const r = await ana.get(`/download/${html.id}?inline=1`);
    assert.equal(r.headers.get('content-type'), 'application/octet-stream');
    assert.match(r.headers.get('content-disposition'), /^attachment/);
    const img = (await ana.upload('foto.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xd9]))).data.file;
    const ri = await ana.get(`/download/${img.id}?inline=1`);
    assert.equal(ri.headers.get('content-type'), 'image/jpeg');
    assert.match(ri.headers.get('content-disposition'), /^inline/);
  });

  it('enlace firmado: sirve sin cookie, con rangos; manipulado o caducado no', async () => {
    const l = (await ana.post(`/files/${file.id}/link`)).data;
    const anon = await fetch(t.base + l.path, { headers: { range: 'bytes=10-19' } });
    assert.equal(anon.status, 206);
    assert.ok(Buffer.compare(Buffer.from(await anon.arrayBuffer()), data.subarray(10, 20)) === 0);
    const tampered = l.path.slice(0, -3) + (l.path.endsWith('AAA') ? 'BBB' : 'AAA');
    assert.equal((await fetch(t.base + tampered)).status, 403);
    t.clk.advance(16 * 60 * 1000);
    assert.equal((await fetch(t.base + l.path)).status, 403, 'caducado');
  });

  it('miniatura: objeto aparte; el original no cambia', async () => {
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), pattern(2000, 3), Buffer.from([0xff, 0xd9])]);
    assert.equal((await ana.put(`/files/${file.id}/thumbnail`, jpeg, { 'content-type': 'image/jpeg' })).status, 200);
    const th = await ana.get(`/files/${file.id}/thumbnail`);
    assert.equal(th.status, 200);
    assert.ok(Buffer.compare(th.data, jpeg) === 0);
    const etag = th.headers.get('etag');
    assert.equal((await ana.get(`/files/${file.id}/thumbnail`, { 'if-none-match': etag })).status, 304);
    assert.equal((await ana.put(`/files/${file.id}/thumbnail`, Buffer.from('<svg/>'), { 'content-type': 'image/svg+xml' })).status, 400);
    assert.equal((await ana.put(`/files/${file.id}/thumbnail`, Buffer.from('nojpeg'), { 'content-type': 'image/jpeg' })).status, 400);
    const meta = (await ana.get(`/files/${file.id}`)).data.file;
    assert.equal(meta.sha256, file.sha256);
    assert.equal(meta.hasThumbnail, true);
    assert.equal(sha256((await ana.get(`/download/${file.id}`)).data), file.sha256);
  });

  it('una ruta inexistente o un metodo equivocado dan un error legible', async () => {
    const r = await ana.get('/nada');
    assert.equal(r.status, 404);
    assert.equal(r.data.error.code, 'not_found');
    const m = await ana.raw('PATCH', '/uploads', {});
    assert.equal(m.status, 405);
  });
});

describe('reinicio del servidor a mitad de una subida', () => {
  it('las partes recibidas sobreviven y la subida termina', async () => {
    const t1 = await boot();
    const ana1 = await webClient(t1.base);
    const data = pattern(600_000, 61);
    const c = (await ana1.post('/uploads', { name: 'tras-reinicio.bin', size: data.length, chunkSize: 100_000, sha256: sha256(data) })).data.upload;
    for (const n of [1, 2, 4]) await ana1.putPart(c.uploadId, n, data.subarray((n - 1) * 100_000, n * 100_000));
    await t1.cleanup(true);                              // apagado, datos conservados
    const t2 = await boot({ dir: t1.dataDir, clk: t1.clk });
    const ana2 = makeClient(t2.base, ana1.headers);       // la misma sesion
    const st = (await ana2.get(`/uploads/${c.uploadId}`)).data.upload;
    assert.deepEqual(st.receivedParts, [1, 2, 4]);
    for (const n of [3, 5, 6]) await ana2.putPart(c.uploadId, n, data.subarray((n - 1) * 100_000, n * 100_000));
    const done = await ana2.post(`/uploads/${c.uploadId}/complete`, {});
    assert.equal(done.status, 200);
    assert.equal(done.data.file.sha256, sha256(data));
    await t2.cleanup();
  });

  it('un corte durante "completando" vuelve a "activa" y la cuota cuadra', async () => {
    const t1 = await boot();
    const ana1 = await webClient(t1.base);
    const data = pattern(200_000, 71);
    const c = (await ana1.post('/uploads', { name: 'corte.bin', size: data.length, chunkSize: 100_000 })).data.upload;
    await ana1.putPart(c.uploadId, 1, data.subarray(0, 100_000));
    await ana1.putPart(c.uploadId, 2, data.subarray(100_000));
    t1.cloud.db.run(`UPDATE uploads SET state = 'completing' WHERE id = ?`, c.uploadId);
    t1.cloud.db.run('UPDATE accounts SET reserved_bytes = 0, used_bytes = 12345');   // contadores desviados
    await t1.cleanup(true);
    const t2 = await boot({ dir: t1.dataDir, clk: t1.clk });
    const ana2 = makeClient(t2.base, ana1.headers);
    assert.equal((await ana2.get(`/uploads/${c.uploadId}`)).data.upload.state, 'active');
    const q = (await ana2.get('/quota')).data.quota;
    assert.equal(q.usedBytes, 0);
    assert.equal(q.reservedBytes, 200_000);
    assert.equal((await ana2.post(`/uploads/${c.uploadId}/complete`, {})).status, 200);
    await t2.cleanup();
  });
});
