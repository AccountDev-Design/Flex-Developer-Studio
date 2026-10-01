// Errores de la API: un codigo ESTABLE (lo leen la web y el P4) y un mensaje
// para personas. Nunca "Error -1": cada fallo dice que paso y que hacer.
export class CloudError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const E = {
  authRequired: () => new CloudError(401, 'auth_required', 'Inicia sesión con tu Flex Account para usar Flex Cloud.'),
  tokenExpired: () => new CloudError(401, 'token_expired', 'Tu sesión caducó. Vuelve a iniciar sesión.'),
  deviceRevoked: () => new CloudError(401, 'device_revoked', 'Este dispositivo ya no está vinculado a la cuenta.'),
  accountUnavailable: () => new CloudError(503, 'account_unavailable', 'Flex Account no responde ahora mismo. Inténtalo en unos segundos.'),
  csrf: () => new CloudError(403, 'csrf_failed', 'Solicitud rechazada por seguridad. Recarga la página.'),
  notFound: (what = 'El elemento') => new CloudError(404, 'not_found', `${what} no existe o no es tuyo.`),
  invalid: (msg, details) => new CloudError(400, 'invalid_request', msg, details),
  nameInvalid: (msg) => new CloudError(400, 'name_invalid', msg),
  nameConflict: (name) => new CloudError(409, 'name_conflict', `Ya existe un elemento llamado "${name}" en esta carpeta.`),
  quotaExceeded: (needed, available) => new CloudError(507, 'quota_exceeded',
    'No queda espacio suficiente en tu Flex Cloud.', { needed, available }),
  fileTooLarge: (max) => new CloudError(413, 'file_too_large', 'El archivo supera el tamaño máximo permitido.', { max }),
  payloadTooLarge: () => new CloudError(413, 'payload_too_large', 'La solicitud es demasiado grande.'),
  uploadNotFound: () => new CloudError(404, 'upload_not_found', 'La subida no existe o ya terminó.'),
  uploadExpired: () => new CloudError(410, 'upload_expired', 'La subida caducó. Empieza de nuevo.'),
  uploadState: (state) => new CloudError(409, 'upload_state', `La subida no admite esa operación (estado: ${state}).`, { state }),
  partRange: (total) => new CloudError(400, 'part_out_of_range', `La parte no existe (la subida tiene ${total}).`, { total }),
  partSize: (expected, got) => new CloudError(400, 'part_size_mismatch', 'La parte no tiene el tamaño esperado.', { expected, got }),
  checksum: (expected, got) => new CloudError(422, 'checksum_mismatch', 'Los datos llegaron alterados (SHA-256 distinto). Se reintentará.', { expected, got }),
  partConflict: () => new CloudError(409, 'part_conflict', 'Esa parte ya se recibió con otro contenido.'),
  incomplete: (missing) => new CloudError(409, 'incomplete_upload', 'Faltan partes por subir.', { missing }),
  range: (size) => new CloudError(416, 'range_not_satisfiable', 'El rango pedido no existe en el archivo.', { size }),
  rateLimited: () => new CloudError(429, 'rate_limited', 'Demasiadas solicitudes. Espera un momento.'),
  folderCycle: () => new CloudError(400, 'folder_cycle', 'No puedes mover una carpeta dentro de sí misma.'),
  linkInvalid: () => new CloudError(403, 'link_invalid', 'El enlace no es válido o caducó.'),
};

export function errorBody(err) {
  if (err instanceof CloudError) {
    return { status: err.status, body: { ok: false, error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } } };
  }
  return { status: 500, body: { ok: false, error: { code: 'internal_error', message: 'Error interno de Flex Cloud. Ya se registró; vuelve a intentarlo.' } } };
}
