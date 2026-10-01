// Miniaturas generadas EN EL NAVEGADOR a partir del archivo local, y subidas
// como objeto aparte. El original que se sube no se toca: ni se recomprime ni
// se reescala. Si el navegador no sabe abrir el formato (HEIC, RAW...), no hay
// miniatura y la web ensena el icono del tipo.
const MAX_SIDE = 320;
const QUALITY = 0.82;

function canvasToJpeg(canvas) {
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/jpeg', QUALITY));
}

function fit(w, h) {
  const s = Math.min(1, MAX_SIDE / Math.max(w, h));
  return [Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s))];
}

async function imageThumb(file) {
  if (file.size > 80 * 1024 * 1024) return null;
  let bmp;
  try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { return null; }
  const [w, h] = fit(bmp.width, bmp.height);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d', { alpha: false }).drawImage(bmp, 0, 0, w, h);
  const meta = { width: bmp.width, height: bmp.height };
  bmp.close?.();
  const blob = await canvasToJpeg(c);
  c.width = c.height = 0;
  return blob ? { blob, meta } : null;
}

function videoThumb(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    let done = false;
    const finish = (r) => { if (done) return; done = true; v.removeAttribute('src'); v.load(); URL.revokeObjectURL(url); resolve(r); };
    const timer = setTimeout(() => finish(null), 8000);
    v.muted = true; v.preload = 'metadata'; v.playsInline = true;
    v.onerror = () => { clearTimeout(timer); finish(null); };
    v.onloadedmetadata = () => {
      const t = Number.isFinite(v.duration) ? Math.min(1, v.duration / 3) : 0;
      v.currentTime = t;
    };
    v.onseeked = async () => {
      clearTimeout(timer);
      if (!v.videoWidth) return finish(null);
      const [w, h] = fit(v.videoWidth, v.videoHeight);
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d', { alpha: false }).drawImage(v, 0, 0, w, h);
      const blob = await canvasToJpeg(c);
      finish(blob ? { blob, meta: { width: v.videoWidth, height: v.videoHeight, durationMs: Math.round((v.duration || 0) * 1000) } } : null);
    };
    v.src = url;
  });
}

export async function makeThumb(file) {
  try {
    if (/^image\/(jpeg|png|webp|gif|bmp|avif)$/.test(file.type)) return await imageThumb(file);
    if (/^video\//.test(file.type)) return await videoThumb(file);
  } catch { /* sin miniatura: no pasa nada */ }
  return null;
}
