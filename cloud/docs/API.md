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

## Perfil teléfono (Flex Storage)

Flex OS Ultra también puede usar como Flex Cloud **un teléfono Android
emparejado** (Flex Phone › Flex Cloud). El teléfono habla **este mismo
contrato** (`/api/cloud/...`, mismas formas JSON, mismos códigos de error), de
modo que el gestor de Flex Cloud del P4 y su web no cambian según el destino.
El servidor del teléfono vive en el repositorio del firmware
(`android/FlexPhone/storage/`, módulo JVM sin dependencias) y su diseño
completo está en `docs/FLEX-STORAGE.md` de ese repositorio. Este servicio no
habla con el teléfono ni lo necesita.

Lo que cambia respecto al servicio:

| | Servicio (este repositorio) | Teléfono (Flex Phone) |
|---|---|---|
| Dónde escucha | Servidor con Flex Account | Solo en la IP de la Wi-Fi del teléfono, puerto 47830 (u otro libre); conexiones de fuera de la red local se cierran sin contestar |
| Quién entra | Cookie de sesión o credencial de dispositivo | Solo el Flex OS emparejado: `Authorization: Bearer <token de sesión>` |
| Cuenta | Flex Account | Ninguna. `/me` devuelve `account.id = "phone:<id>"` y `device.kind = "phone"` |
| Cuota | La del plan | 1, 2 o 5 GB lógicos, los elige la persona en el teléfono (`plan: "phone"`) |
| Partes de subida | 64 KB – 64 MB | 64 KB – 16 MB (8 MB por defecto; los límites salen en `/me` → `limits`) |
| Archivo más grande | 50 GB (`FLEX_CLOUD_MAX_FILE_BYTES`) | 4 GB − 16 B (lo que el P4 sabe recorrer con 32 bits) |
| Conexiones | Las del servidor | 6 a la vez; la séptima recibe `503 server_busy` al instante (nunca se queda colgada) |

**Sesión** (sin cuenta: la autorización es la clave `K` de 32 bytes que el P4
y el teléfono acordaron al emparejarse con ECDH; `K` no viaja nunca):

1. `GET /api/fs/hello` → `{ service: "flex-storage", phoneId, name, model, paired, port }`
   (sin autenticación; nada privado).
2. `GET /api/fs/challenge` → `{ nonce, expiresIn: 60, phoneId }`. Cada reto
   vale 60 s y una sola vez; como mucho 16 vivos.
3. `POST /api/fs/session` `{ p4Id, nonce, mac }` con
   `mac = HMAC-SHA256(K, "flexstorage-v1-sess" ‖ lp(nonce) ‖ lp(p4Id))`
   (`lp` = el campo con un byte de longitud delante) → `{ token, expiresIn,
   mac, phoneId, name }`, donde la `mac` de vuelta es
   `HMAC-SHA256(K, "flexstorage-v1-sess-ok" ‖ lp(nonce) ‖ lp(token))`: el P4
   comprueba que el teléfono también tiene `K` antes de usar el token.

El token (24 bytes aleatorios) **solo vale desde la IP que abrió la sesión**,
caduca a los 30 min sin uso y a las 12 h pase lo que pase, y hay como mucho 4
sesiones (la más vieja cede su sitio). Diez fallos de autenticación en un
minuto desde una IP la bloquean un minuto (`429 rate_limited`). Un P4 que el
teléfono ya no reconoce recibe `403 device_revoked`.

**Cuota**: además de los campos de siempre, `GET /quota` y `/me` añaden
`deviceFreeBytes` (lo que el teléfono tiene libre de verdad) y
`limitedByDevice`. Android no deja reservar una partición para una app, así
que `availableBytes` es el **menor** de dos: lo que queda de la cuota y el
espacio libre del teléfono menos un margen de 512 MB (para no dejar al móvil
sin sitio). `limitedByDevice: true` dice que manda el teléfono; un cliente que
no conozca estos campos los ignora y sigue siendo correcto. Una subida que no
cabe en el teléfono responde `507 quota_exceeded` con `details.available`.

**Enlaces firmados**: `POST /files/:id/link` devuelve una `url` con la **IP
local del teléfono** (`http://<ip>:<puerto>/api/cloud/d/<token>`): 15 minutos,
un solo archivo, solo lectura. Esas respuestas llevan
`Cross-Origin-Resource-Policy: cross-origin` porque las usa la web del P4
(otro origen) en `<img>` y `<video>`; las demás, `same-origin`.

**Límites del servidor del teléfono**: cabeceras ≤ 16 KB y ≤ 64, JSON ≤ 64 KB,
miniaturas ≤ 512 KB, plazo de lectura de 30 s por socket. Todo lo demás
(carpetas, papelera de 30 días, subidas reanudables de 72 h, `Range`/`206`,
`ETag`/`If-Range`, `inline` seguro) se comporta como en el servicio.

**SHA-256 en la web**: las webs de Flex Cloud (la de este repositorio y la del
P4) se pueden abrir por `http://` desde la red local, donde el navegador no
ofrece `crypto.subtle`. Las dos calculan entonces la huella de cada parte en
JavaScript (`web/js/sha256.js` aquí), con el mismo resultado; se prueba contra
`node:crypto` en `test/sha256.test.js`.
