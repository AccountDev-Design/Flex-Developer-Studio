// Almacen de objetos en disco. Los BYTES ORIGINALES de cada archivo, tal cual
// llegaron: ni compresion, ni recodificacion, ni cambio de resolucion. Las
// miniaturas son objetos APARTE (otra clave), nunca sustituyen al original.
//
// Las rutas del disco NUNCA salen de un nombre que ponga el usuario: cada
// objeto vive bajo una clave aleatoria de 32 hex (sin traversal posible) y el
// nombre visible es solo metadato en la base de datos.
//
// Esta es la implementacion de produccion para un servidor con disco propio
// (VPS, contenedor con volumen). Otro backend (S3, R2, Azure) implementaria la
// misma interfaz; ver docs/ARCHITECTURE.md.
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, rename, rm, stat, unlink, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { E } from '../http/errors.js';

const KEY_RE = /^[a-f0-9]{32}$/;
const UPLOAD_RE = /^upl_[a-z0-9]{20,40}$/;

export function newStorageKey() { return randomBytes(16).toString('hex'); }

async function fsyncDir(dir) {
  let fh;
  try { fh = await open(dir, 'r'); await fh.sync(); } catch { /* algunos FS no lo admiten */ } finally { await fh?.close(); }
}

export class FsObjectStore {
  constructor({ objectsDir, uploadsDir }) {
    this.objectsDir = objectsDir;
    this.uploadsDir = uploadsDir;
  }

  async init() {
    await mkdir(join(this.objectsDir, 'tmp'), { recursive: true });
    await mkdir(this.uploadsDir, { recursive: true });
  }

  objectPath(key) {
    if (!KEY_RE.test(key)) throw new Error('clave de objeto no valida');
    return join(this.objectsDir, key.slice(0, 2), key);
  }

  uploadDir(uploadId) {
    if (!UPLOAD_RE.test(uploadId)) throw new Error('id de subida no valido');
    return join(this.uploadsDir, uploadId);
  }

  partPath(uploadId, n) { return join(this.uploadDir(uploadId), `${n}.part`); }

  // Recibe una parte en streaming, calculando SHA-256 y tamano mientras llega.
  // No se acepta ni un byte de mas: la conexion se corta en cuanto se supera
  // `maxBytes`. Devuelve un temporal; quien llama decide si se confirma.
  async receivePart(uploadId, n, source, maxBytes) {
    const dir = this.uploadDir(uploadId);
    await mkdir(dir, { recursive: true });
    const tmp = join(dir, `${n}.${randomBytes(6).toString('hex')}.tmp`);
    const hash = createHash('sha256');
    let size = 0;
    const meter = new Transform({
      transform(chunk, _enc, cb) {
        size += chunk.length;
        if (size > maxBytes) { cb(E.partSize(maxBytes, size)); return; }
        hash.update(chunk);
        cb(null, chunk);
      },
    });
    const out = createWriteStream(tmp, { flags: 'wx' });
    try {
      await pipeline(source, meter, out);
      const fh = await open(tmp, 'r+');
      try { await fh.sync(); } finally { await fh.close(); }
    } catch (e) {
      await unlink(tmp).catch(() => {});
      throw e;
    }
    return { tmp, size, sha256: hash.digest('hex') };
  }

  async commitPart(tmp, uploadId, n) { await rename(tmp, this.partPath(uploadId, n)); }
  async discard(path) { await unlink(path).catch(() => {}); }

  // Une las partes en el objeto final, verificando el SHA-256 de TODO el
  // archivo mientras se escribe. El objeto solo aparece con su nombre
  // definitivo despues de fsync: un corte de luz deja o el objeto entero o
  // nada (el temporal lo limpia el arranque).
  async assemble(uploadId, totalParts, storageKey) {
    const tmp = join(this.objectsDir, 'tmp', `${storageKey}.${randomBytes(4).toString('hex')}.tmp`);
    const hash = createHash('sha256');
    let size = 0;
    const out = await open(tmp, 'wx');
    try {
      const buf = Buffer.allocUnsafe(1024 * 1024);          // 1 MB reutilizado: nunca el archivo entero en RAM
      for (let n = 1; n <= totalParts; n++) {
        const part = await open(this.partPath(uploadId, n), 'r');
        try {
          for (;;) {
            const { bytesRead } = await part.read(buf, 0, buf.length, null);
            if (!bytesRead) break;
            const slice = buf.subarray(0, bytesRead);
            hash.update(slice);
            let off = 0;
            while (off < bytesRead) {
              const { bytesWritten } = await out.write(slice, off, bytesRead - off);
              off += bytesWritten;
            }
            size += bytesRead;
          }
        } finally { await part.close(); }
      }
      await out.sync();
    } catch (e) {
      await out.close().catch(() => {});
      await unlink(tmp).catch(() => {});
      throw e;
    }
    await out.close();
    return { tmp, size, sha256: hash.digest('hex') };
  }

  async publish(tmp, storageKey) {
    const final = this.objectPath(storageKey);
    await mkdir(join(this.objectsDir, storageKey.slice(0, 2)), { recursive: true });
    await rename(tmp, final);
    await fsyncDir(join(this.objectsDir, storageKey.slice(0, 2)));
  }

  async putSmall(storageKey, buffer) {
    const tmp = join(this.objectsDir, 'tmp', `${storageKey}.${randomBytes(4).toString('hex')}.tmp`);
    await writeFile(tmp, buffer, { flag: 'wx' });
    await this.publish(tmp, storageKey);
  }

  async size(storageKey) {
    try { return (await stat(this.objectPath(storageKey))).size; } catch { return -1; }
  }

  read(storageKey, start, end) {
    return createReadStream(this.objectPath(storageKey), { start, end, highWaterMark: 256 * 1024 });
  }

  async remove(storageKey) {
    if (!storageKey) return;
    await rm(this.objectPath(storageKey), { force: true });
  }

  async removeUpload(uploadId) {
    await rm(this.uploadDir(uploadId), { recursive: true, force: true });
  }

  // Temporales de una ejecucion anterior (corte de luz a mitad de unir).
  async sweepTemp() {
    const dir = join(this.objectsDir, 'tmp');
    let n = 0;
    for (const f of await readdir(dir).catch(() => [])) { await unlink(join(dir, f)).catch(() => {}); n++; }
    return n;
  }

  async listUploadDirs() {
    return (await readdir(this.uploadsDir).catch(() => [])).filter((d) => UPLOAD_RE.test(d));
  }

  // Temporales de partes que nunca se confirmaron.
  async sweepPartTemps(uploadId) {
    const dir = this.uploadDir(uploadId);
    for (const f of await readdir(dir).catch(() => [])) if (f.endsWith('.tmp')) await unlink(join(dir, f)).catch(() => {});
  }
}
