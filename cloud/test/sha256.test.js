// SHA-256 de la web (web/js/sha256.js).
//
// Las subidas de Flex Cloud mandan la huella de cada parte. En https o en
// localhost la calcula el navegador (crypto.subtle); por http:// desde la red
// local el navegador no la ofrece y la calcula sha256.js. Las dos tienen que dar
// EXACTAMENTE lo mismo, o el servidor rechazaria partes buenas: se compara con
// node:crypto en los vectores del NIST, en tamanos de borde (55/56/63/64 bytes,
// donde cambia el relleno) y con datos aleatorios partidos al azar.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';
import { Sha256, sha256Hex } from '../web/js/sha256.js';

const ref = (u8) => createHash('sha256').update(u8).digest('hex');
const enc = (s) => new TextEncoder().encode(s);

describe('web: SHA-256 sin crypto.subtle', () => {
  it('vectores del NIST (FIPS 180-4)', () => {
    const v = [
      ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
      ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
      ['abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
        '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'],
      ['abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu',
        'cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1'],
    ];
    for (const [s, h] of v) assert.equal(new Sha256().update(enc(s)).hex(), h, JSON.stringify(s));
    const million = new Uint8Array(1_000_000).fill(0x61);
    assert.equal(new Sha256().update(million).hex(),
      'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0', 'un millon de "a"');
  });

  it('tamanos de borde del relleno', () => {
    for (const n of [1, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 1000, 4096]) {
      const u8 = randomBytes(n);
      assert.equal(new Sha256().update(u8).hex(), ref(u8), `${n} bytes`);
    }
  });

  it('a trozos da lo mismo que de una vez (300 particiones al azar)', () => {
    for (let k = 0; k < 300; k++) {
      const u8 = new Uint8Array(randomBytes(1 + Math.floor(Math.random() * 3000)));
      const h = new Sha256();
      for (let i = 0; i < u8.length;) {
        const n = Math.min(u8.length - i, Math.floor(Math.random() * 200));
        h.update(u8.subarray(i, i + n));
        i += n;
      }
      assert.equal(h.hex(), ref(u8));
    }
  });

  it('una parte de subida entera (8 MB) por el camino de JavaScript', async () => {
    const u8 = new Uint8Array(randomBytes(8 * 1024 * 1024));
    assert.equal(await sha256Hex(u8.buffer, undefined), ref(u8));
  });

  it('usa crypto.subtle si existe, y si falla calcula aqui', async () => {
    const u8 = enc('Flex Cloud');
    let calls = 0;
    const subtle = { digest: async (alg, d) => { calls++; assert.equal(alg, 'SHA-256'); return new Uint8Array(createHash('sha256').update(d).digest()).buffer; } };
    assert.equal(await sha256Hex(u8, subtle), ref(u8));
    assert.equal(calls, 1, 'con contexto seguro se usa la del navegador');
    const denied = { digest: async () => { throw new Error('NotSupportedError'); } };
    assert.equal(await sha256Hex(u8, denied), ref(u8), 'si el navegador la niega, el resultado es el mismo');
    assert.equal(await sha256Hex(u8, null), ref(u8), 'sin crypto.subtle (http:// en la red local)');
    assert.equal(await sha256Hex(u8.buffer), ref(u8), 'con el crypto.subtle real de Node');
  });
});
