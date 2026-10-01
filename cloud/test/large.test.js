// ARCHIVOS GRANDES: 10, 50, 160 y 500 MB. Se ejecuta con FLEX_CLOUD_LARGE_TESTS=1
// (npm run test:large): escribe ~1,5 GB en disco temporal.
//
// Para cada tamano: subida por partes con un corte de conexion a mitad de una
// parte, "reinicio" del cliente (se pierde todo lo que tenia en memoria) y
// reanudacion con la misma clave, una parte repetida, verificacion SHA-256 del
// archivo entero, descarga en streaming sin acumular y reanudacion por rangos.
// Ademas se mide que la memoria del proceso NO crece con el tamano del archivo.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { boot, webClient, deviceClient, interruptedPart, makeClient } from './helpers.js';

const RUN = process.env.FLEX_CLOUD_LARGE_TESTS === '1';
const MB = 1024 * 1024;

// Generador determinista por partes: el archivo nunca existe entero en RAM.
function partBytes(seed, n, chunk, size) {
  const start = (n - 1) * chunk;
  const len = Math.min(chunk, size - start);
  const b = Buffer.allocUnsafe(len);
  let x = (seed * 2654435761 + n * 40503) >>> 0 || 1;
  for (let i = 0; i + 4 <= len; i += 4) { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; b.writeUInt32LE(x, i); }
  for (let i = len - (len % 4); i < len; i++) b[i] = (x >>> ((i % 4) * 8)) & 255;
  return b;
}

function wholeSha(seed, chunk, size) {
  const h = createHash('sha256');
  for (let n = 1; (n - 1) * chunk < size; n++) h.update(partBytes(seed, n, chunk, size));
  return h.digest('hex');
}

const sample = { peak: 0 };
function memSample() {
  const m = process.memoryUsage();
  const v = m.heapUsed + m.arrayBuffers;
  if (v > sample.peak) sample.peak = v;
}

async function streamSha(res, abortAfter) {
  const h = createHash('sha256');
  let got = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    h.update(value);
    got += value.length;
    memSample();
    if (abortAfter && got >= abortAfter) { await reader.cancel(); break; }
  }
  return { sha: h, got };
}

describe('archivos grandes (10 / 50 / 160 / 500 MB)', { skip: !RUN && 'FLEX_CLOUD_LARGE_TESTS=1 para ejecutarla' }, () => {
  let t, ana;
  before(async () => { t = await boot({ env: { FLEX_CLOUD_PLANS: JSON.stringify({ free: 2 * 1024 * MB }) } }); ana = await webClient(t.base); });
  after(async () => t.cleanup());

  const cases = [
    { mb: 10, chunk: 8 * MB, who: 'web' },
    { mb: 50, chunk: 8 * MB, who: 'web' },
    { mb: 160, chunk: 8 * MB, who: 'web' },
    { mb: 160, chunk: 256 * 1024, who: 'p4' },     // partes como las del P4: 640 peticiones
    { mb: 500, chunk: 8 * MB, who: 'web' },
  ];

  for (const c of cases) {
    it(`${c.mb} MB en partes de ${c.chunk >= MB ? c.chunk / MB + ' MB' : c.chunk / 1024 + ' KB'} (${c.who})`, { timeout: 15 * 60 * 1000 }, async () => {
      const size = c.mb * MB + 12345;                       // no multiplo exacto de la parte
      const seed = c.mb + (c.who === 'p4' ? 1000 : 0);
      const cli = c.who === 'p4' ? await deviceClient(t.base, ana) : ana;
      const full = wholeSha(seed, c.chunk, size);
      const clientKey = `test:${seed}:${size}`;
      const name = `Vídeo ${c.mb} MB ${c.who} 🎬.avi`;
      const started = Date.now();
      sample.peak = 0;
      const base0 = process.memoryUsage();
      const before = base0.heapUsed + base0.arrayBuffers;

      let u = (await cli.post('/uploads', { name, size, chunkSize: c.chunk, sha256: full, clientKey })).data.upload;
      const total = u.totalParts;
      const cut = Math.max(2, Math.floor(total / 3));

      // 1) Primer tercio, y la parte `cut` se corta a mitad (Wi-Fi perdido).
      for (let n = 1; n < cut; n++) assert.equal((await cli.putPart(u.uploadId, n, partBytes(seed, n, c.chunk, size))).status, 200);
      const pb = partBytes(seed, cut, c.chunk, size);
      await interruptedPart(t.base, cli.headers, u.uploadId, cut, pb, Math.floor(pb.length / 2));
      memSample();

      // 2) "Reinicio" del cliente: solo sabe la clave. El servidor le dice que tiene.
      const fresh = makeClient(t.base, cli.headers);
      u = (await fresh.post('/uploads', { name, size, chunkSize: c.chunk, sha256: full, clientKey })).data.upload;
      assert.equal(u.resumed, true);
      assert.deepEqual(u.receivedParts, Array.from({ length: cut - 1 }, (_, i) => i + 1), 'la parte cortada no cuenta');

      // 3) El resto, con una parte repetida por el camino.
      for (let n = cut; n <= total; n++) {
        const r = await fresh.putPart(u.uploadId, n, partBytes(seed, n, c.chunk, size));
        assert.equal(r.status, 200, `parte ${n}`);
        if (n % 16 === 0) memSample();
      }
      const dup = await fresh.putPart(u.uploadId, 1, partBytes(seed, 1, c.chunk, size));
      assert.equal(dup.data.alreadyReceived, true);
      const done = await fresh.post(`/uploads/${u.uploadId}/complete`, {});
      assert.equal(done.status, 200);
      assert.equal(done.data.file.size, size);
      assert.equal(done.data.file.sha256, full, 'SHA-256 del archivo entero verificado');
      const upMs = Date.now() - started;

      // 4) Descarga completa en streaming.
      const id = done.data.file.id;
      const dl = await fetch(`${t.base}/api/cloud/download/${id}`, { headers: cli.headers });
      assert.equal(dl.status, 200);
      const whole = await streamSha(dl);
      assert.equal(whole.got, size);
      assert.equal(whole.sha.digest('hex'), full, 'los bytes descargados son los originales');

      // 5) Descarga cortada al 40 % y reanudada con Range + If-Range.
      const h = createHash('sha256');
      const first = await fetch(`${t.base}/api/cloud/download/${id}`, { headers: cli.headers });
      const part1 = await (async () => {
        const reader = first.body.getReader(); let got = 0;
        for (;;) {
          const { done: d, value } = await reader.read();
          if (d) break;
          const take = Math.min(value.length, Math.floor(size * 0.4) - got);
          if (take > 0) h.update(value.subarray(0, take));
          got += Math.max(0, take);
          if (got >= Math.floor(size * 0.4)) { await reader.cancel(); break; }
        }
        return got;
      })();
      const rest = await fetch(`${t.base}/api/cloud/download/${id}`, { headers: { ...cli.headers, range: `bytes=${part1}-`, 'if-range': `"${full}"` } });
      assert.equal(rest.status, 206);
      const reader = rest.body.getReader();
      let got2 = 0;
      for (;;) { const { done: d, value } = await reader.read(); if (d) break; h.update(value); got2 += value.length; memSample(); }
      assert.equal(part1 + got2, size);
      assert.equal(h.digest('hex'), full, 'descarga reanudada identica');

      // 6) Memoria: el pico no depende del tamano del archivo (partes de 8 MB
      // como mucho en vuelo + buffers de 1 MB del ensamblado y 256 KB de lectura).
      const growth = (sample.peak - before) / MB;
      assert.ok(growth < 6 * (c.chunk / MB) + 64, `memoria acotada: crecio ${growth.toFixed(1)} MB`);

      const q = (await ana.get('/quota')).data.quota;
      assert.equal(q.reservedBytes, 0);
      console.log(`    ${c.mb} MB (${c.who}): ${total} partes, subida+verificacion ${(upMs / 1000).toFixed(1)} s, pico de memoria +${growth.toFixed(1)} MB`);
      await ana.post(`/files/${id}/permanent-delete`);
    });
  }
});
