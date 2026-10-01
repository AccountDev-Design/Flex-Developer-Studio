# API de Flex Cloud (`/api/cloud`)

Todas las respuestas son JSON. Éxito: `{ "ok": true, ... }`. Error:
`{ "ok": false, "error": { "code": "...", "message": "texto para personas", "details": {...} } }`.
Los `code` son estables (los leen la web y el P4); los `message` están en
español y dicen qué pasó y qué hacer.

**Autenticación**: cookie de sesión de Flex Developer Studio (web) o
`Authorization: Bearer <credencial de dispositivo>` (Flex OS Ultra). Con
cookie, toda petición que modifica algo lleva `X-Flex-Cloud: 1` y debe venir
del mismo origen (CSRF).

## Cuenta y cuota

| Método | Ruta | Qué hace |
|---|---|---|
| GET | `/health` | Estado del servicio (sin autenticación) |
| GET | `/me` | Cuenta (de Flex Account), dispositivo si lo hay, cuota y límites |
| GET | `/quota` | `totalBytes`, `usedBytes` (incluye papelera), `reservedBytes` (subidas en curso), `trashBytes`, `availableBytes`, `percentUsed`, `state` (`ok`/`low`/`full`), `plan` |

## Archivos y carpetas

| Método | Ruta | Qué hace |
|---|---|---|
| GET | `/files?parentId=&sort=name\|date\|size&order=asc\|desc&limit=&cursor=&kind=` | Contenido de una carpeta (`parentId` vacío o `root` = raíz). Carpetas primero |
| GET | `/files?view=recent&kind=media` | Recientes (`kind`: `photo`, `video`, `audio`, `document`, `archive`, `other`, `media` = fotos+vídeos) |
| GET | `/files?view=search&q=` | Búsqueda por nombre (sin distinguir mayúsculas; `%` y `_` literales) |
| GET | `/files?view=trash` | Papelera (elementos borrados directamente; una carpeta lleva `itemCount`) |
| GET | `/files/:id` | Metadatos + ruta (`path`) |
| PATCH | `/files/:id` `{name?, parentId?}` | Renombrar / mover |
| DELETE | `/files/:id` | A la papelera (`?permanent=1` = definitivo) |
| POST | `/files/:id/restore` | Restaurar (si su carpeta ya no existe, a la raíz; si el nombre está ocupado, se numera) |
| POST | `/files/:id/permanent-delete` | Borrar definitivamente y liberar cuota |
| PUT | `/files/:id/thumbnail` | Miniatura JPEG/PNG/WebP ≤ 512 KB (objeto aparte, el original no cambia) |
| GET | `/files/:id/thumbnail` | Miniatura (ETag, `304`) |
| POST | `/files/:id/link` | Enlace firmado temporal (15 min por defecto) → `{ url, path, expiresAt }` |
| POST | `/folders` `{name, parentId?, conflict?: "fail"\|"rename"}` | Crear carpeta |
| GET | `/folders/:id` | Carpeta + ruta |
| PATCH | `/folders/:id` `{name?, parentId?}` | Renombrar / mover (sin ciclos) |
| DELETE | `/folders/:id` | A la papelera con todo su contenido (un solo lote restaurable) |
| POST | `/folders/:id/restore` · `/folders/:id/permanent-delete` | Igual que archivos |
| POST | `/trash/restore` `{id}` · `/trash/empty` | Restaurar por id · vaciar la papelera |

Objeto archivo: `{ type:"file", id, name, parentId, size, mime, kind, sha256, version, status, storageLocation, source:"web"|"device", hasThumbnail, metadata, createdAt, updatedAt, deletedAt? }`.

## Subidas reanudables

1. `POST /uploads`
   `{ name, size, mimeType?, parentId?, sha256?, chunkSize?, clientKey?, conflict?, metadata? }`
   → `201 { upload }` (nueva) o `200 { upload: { resumed: true, ... } }` si ya
   existía una sesión activa con la misma `clientKey`, nombre, tamaño y carpeta.
   Reserva la cuota en ese momento (atómico); `507 quota_exceeded` si no cabe.
   `chunkSize` entre 64 KB y 64 MB (8 MB por defecto; el P4 usa 256 KB).
2. `PUT /uploads/:id/parts/:n` (1..`totalParts`), cuerpo = bytes de la parte,
   cabecera `X-Part-SHA256: <hex>` o `Content-Digest: sha-256=:<base64>:`.
   Todas las partes miden `chunkSize` salvo la última. Respuestas:
   `200 { alreadyReceived, receivedBytes, receivedCount }` · `422 checksum_mismatch` ·
   `400 part_size_mismatch` · `409 part_conflict` (otra parte con ese número ya se
   recibió con otro contenido) · `410 upload_expired`.
   Repetir una parte ya recibida no la reescribe.
3. `GET /uploads/:id` (o `/status`) → `receivedParts`, `receivedBytes`,
   `state` (`active`, `completing`, `completed`, `aborted`, `expired`, `failed`), `expiresAt`.
4. `POST /uploads/:id/complete` `{ sha256? }` → une las partes verificando el
   SHA-256 del archivo entero y devuelve `{ file, quota }`. Idempotente.
   `409 incomplete_upload { missing: [...] }` si faltan partes; `422
   checksum_mismatch` si el archivo entero no coincide (la reserva se libera).
5. `DELETE /uploads/:id` → cancelar y liberar la reserva. `GET /uploads` → subidas activas.

Las subidas caducan tras 72 h sin actividad (`FLEX_CLOUD_UPLOAD_TTL_HOURS`) y
liberan su reserva.

## Descargas y streaming

`GET /download/:id` (y `GET /d/:token` con enlace firmado):

- `Accept-Ranges: bytes`, `Range: bytes=a-b | a- | -n` → `206` + `Content-Range`;
  fuera de rango → `416`.
- `ETag: "<sha256>"`; `If-Range` para reanudar sin mezclar versiones.
- `HEAD` sin cuerpo. `?inline=1` solo para imagen/vídeo/audio/PDF/texto; HTML,
  SVG, XML y JS se sirven siempre como descarga. Toda respuesta de archivo lleva
  `Content-Security-Policy: default-src 'none'; sandbox`.
- `Content-Disposition` con nombre ASCII de respaldo y `filename*=UTF-8''…`.

## Códigos de error

`auth_required`, `token_expired`, `device_revoked`, `account_unavailable`,
`csrf_failed`, `not_found`, `invalid_request`, `name_invalid`, `name_conflict`,
`folder_cycle`, `quota_exceeded`, `file_too_large`, `payload_too_large`,
`upload_not_found`, `upload_expired`, `upload_state`, `part_out_of_range`,
`part_size_mismatch`, `checksum_mismatch`, `part_conflict`, `incomplete_upload`,
`range_not_satisfiable`, `link_invalid`, `rate_limited`, `method_not_allowed`,
`internal_error`.
