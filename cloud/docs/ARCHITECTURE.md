# Arquitectura de Flex Cloud

## Qué había (auditoría)

- **Flex-Developer-Studio** solo contenía el SDK de paquetes (`sdk/`, Python).
  No había servidor, base de datos, almacenamiento ni web en el repositorio:
  el sitio de Flex Developer Studio (Flex Account, `/activate`,
  `/api/devices/code`, `/api/catalog`) está publicado aparte y su código no
  está aquí. Tampoco se pudo inspeccionar en vivo (la red del entorno de
  trabajo bloquea ese dominio).
- Ningún proveedor de almacenamiento (S3, R2, Firebase, Supabase…) estaba en
  uso en el repositorio, así que no se asumió ninguno.
- El ecosistema ya usa Node.js (servicio de render del navegador y SDK en
  `Flex-OS-Ecosistema`) y una web estática sin compilación (la biblioteca web
  del P4). Flex Cloud sigue ese patrón.

## Decisiones

| Pieza | Elección | Por qué |
|---|---|---|
| Servidor | Node ≥ 22.13, `node:http` | Sin dependencias de ejecución: nada que actualizar ni que comprometa la cadena de suministro |
| Metadatos | SQLite (`node:sqlite`, WAL) | Transacciones ACID para la cuota y las subidas simultáneas; un fichero, copia de seguridad trivial |
| Bytes | Almacén de objetos en disco (`FsObjectStore`) | Lo que existe en cualquier servidor; claves aleatorias, escritura con `fsync` y renombrado atómico |
| Identidad | Introspección contra Flex Account | No hay segundo login; ver `FLEX_ACCOUNT_INTEGRATION.md` |
| Web | HTML + CSS + módulos ES, sin framework | Coherente con la web del P4; carga instantánea, CSP estricta (solo scripts propios) |

Los vídeos y fotos **nunca** entran en la base de datos: solo su metadata.

### Cambiar de almacén (S3, R2, Azure)

`FsObjectStore` define la interfaz (`receivePart`, `commitPart`, `assemble`,
`publish`, `read(start, end)`, `remove`, `putSmall`…). Un backend S3 la
implementaría con *multipart upload* (las partes de 8 MB ya cumplen el mínimo
de 5 MB de S3) y `GetObject` con `Range`; las descargas podrían redirigir a
URLs prefirmadas de corta duración. Las credenciales del almacén vivirían solo
en el servidor: el P4 y el navegador nunca las ven.

## Modelo de datos

- `accounts(id, flex_address, display_name, plan, quota_override, used_bytes, reserved_bytes)`
- `folders(id, account_id, parent_id, name, name_key, created_at, updated_at, deleted_at, trash_root, trash_batch)`
- `files(id, account_id, parent_id, name, name_key, storage_key, storage_location, size, mime, kind, sha256, status, version, source, metadata, thumb_key, …, deleted_at, trash_root, trash_batch)`
- `uploads(id, account_id, parent_id, name, mime, size, chunk_size, total_parts, received_bytes, sha256, client_key, state, reserved_bytes, storage_key, file_id, expires_at, …)`
- `upload_parts(upload_id, part_number, size, sha256, received_at)`

`name_key` = nombre en NFC y minúsculas: dos nombres que solo difieren en
mayúsculas o en la forma Unicode no pueden convivir en la misma carpeta (al
bajarlos a un disco que no distingue, se pisarían).

## Cuota

- Total = `quota_override` o el plan (`FLEX_CLOUD_PLANS`, 5 GB gratis por defecto).
- `used_bytes` = archivos guardados, **incluida la papelera**; `reserved_bytes`
  = subidas en curso. Disponible = total − usado − reservado.
- Crear una subida reserva su tamaño en una transacción; completar mueve la
  reserva a "usado"; cancelar, caducar o fallar la libera; borrar definitivo
  libera. Al arrancar se recalculan los contadores desde las tablas.

## Subida reanudable (resumen)

Partes con SHA-256 cada una → el servidor escribe cada parte en un temporal
mientras calcula su hash y la confirma (renombrado + fila) solo si cuadra; la
misma parte por dos conexiones (reintento tras un corte de Wi-Fi que el
servidor aún no detectó) no se bloquea: gana la primera completa. Al completar
se unen con un búfer de 1 MB verificando el SHA-256 de todo el archivo, se hace
`fsync` y se publica con un renombrado. Un corte en mitad deja la subida
`active` con sus partes (el arranque la recupera).

## Calidad original

El servidor nunca transforma un archivo: guarda exactamente los bytes
recibidos (verificados por SHA-256) y los devuelve igual. Las miniaturas las
genera el cliente (la web con `<canvas>`, el P4 con su codificador JPEG) y se
guardan como objetos separados.

## Límites conocidos

- Un solo proceso: los cerrojos de confirmación de partes son en memoria.
  Para varias instancias haría falta un cerrojo compartido (o el backend S3).
- `node:sqlite` está marcado como experimental en Node 22 (estable en 24).
- La web no puede reabrir un archivo del disco tras recargar sin que la
  persona lo vuelva a elegir (limitación del navegador); la sesión sí
  sobrevive y continúa donde iba.
