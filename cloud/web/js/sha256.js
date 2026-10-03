// SHA-256 (FIPS 180-4) para las partes de las subidas.
//
// Flex Cloud exige la huella de cada parte (x-part-sha256). Con https o en
// localhost se usa la del navegador (crypto.subtle, rapida y nativa); pero esta
// web tambien se abre por http:// desde la red local (otro equipo contra el
// servidor de desarrollo, o la web de Flex OS Ultra con Flex Cloud en el
// telefono), y ahi el navegador NO ofrece crypto.subtle: es solo para contextos
// seguros. En ese caso se calcula aqui, en JavaScript, con el mismo resultado.
// Es la misma implementacion que la web del P4 (webui/app.js, FX.Sha256).
const K = new Int32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);

function block(H, W, b, p) {
  for (let i = 0; i < 16; i++, p += 4) W[i] = (b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3];
  for (let i = 16; i < 64; i++) {
    const x = W[i - 15], y = W[i - 2];
    const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
    const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
    W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
  }
  let a = H[0], b1 = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
  for (let i = 0; i < 64; i++) {
    const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
    const t1 = (h + S1 + ((e & f) ^ (~e & g)) + K[i] + W[i]) | 0;
    const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
    const t2 = (S0 + ((a & b1) ^ (a & c) ^ (b1 & c))) | 0;
    h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b1; b1 = a; a = (t1 + t2) | 0;
  }
  H[0] = (H[0] + a) | 0; H[1] = (H[1] + b1) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
  H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
}

/** SHA-256 incremental: se alimenta a trozos (un archivo enorme nunca entero en memoria). */
export class Sha256 {
  constructor() {
    this.h = new Int32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    this.w = new Int32Array(64);
    this.buf = new Uint8Array(64);
    this.n = 0;
    this.len = 0;
  }

  update(u8) {
    const n = u8.length;
    let i = 0;
    this.len += n;
    if (this.n) {
      const take = Math.min(64 - this.n, n);
      this.buf.set(u8.subarray(0, take), this.n);
      this.n += take; i = take;
      if (this.n < 64) return this;
      block(this.h, this.w, this.buf, 0);
      this.n = 0;
    }
    for (; i + 64 <= n; i += 64) block(this.h, this.w, u8, i);
    if (i < n) { this.buf.set(u8.subarray(i), 0); this.n = n - i; }
    return this;
  }

  digest() {
    const L = this.n < 56 ? 64 : 128, pad = new Uint8Array(L);
    pad.set(this.buf.subarray(0, this.n));
    pad[this.n] = 0x80;
    const hi = Math.floor(this.len / 0x20000000), lo = (this.len * 8) >>> 0;
    for (let k = 0; k < 4; k++) { pad[L - 8 + k] = (hi >>> (24 - 8 * k)) & 255; pad[L - 4 + k] = (lo >>> (24 - 8 * k)) & 255; }
    block(this.h, this.w, pad, 0);
    if (L === 128) block(this.h, this.w, pad, 64);
    const out = new Uint8Array(32);
    for (let k = 0; k < 8; k++) { const v = this.h[k]; out[4 * k] = v >>> 24; out[4 * k + 1] = (v >>> 16) & 255; out[4 * k + 2] = (v >>> 8) & 255; out[4 * k + 3] = v & 255; }
    return out;
  }

  hex() { return Array.from(this.digest(), (b) => b.toString(16).padStart(2, '0')).join(''); }
}

/**
 * Huella en hexadecimal de un ArrayBuffer o Uint8Array: la del navegador si la
 * hay (contexto seguro), y si no, la de aqui. `subtle` se puede inyectar (pruebas).
 */
export async function sha256Hex(data, subtle = globalThis.crypto?.subtle) {
  const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (subtle && typeof subtle.digest === 'function') {
    try {
      const d = new Uint8Array(await subtle.digest('SHA-256', u8));
      return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
    } catch { /* algunos navegadores la exponen pero la niegan: se calcula aqui */ }
  }
  return new Sha256().update(u8).hex();
}
