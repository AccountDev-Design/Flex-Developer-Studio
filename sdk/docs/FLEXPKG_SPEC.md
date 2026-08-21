# Flex Package Format v1 (`.flexpkg`)

Estado: versión inicial estable del contenedor. Todos los enteros usan little-endian.

## Objetivos

- Validación en streaming en dispositivos ESP32-P4.
- Límites estrictos para impedir agotamiento de memoria o almacenamiento.
- Integridad por archivo y del contenido completo.
- Identidad criptográfica del desarrollador mediante ECDSA P-256.
- Formato determinista para que el mismo proyecto produzca contenido reproducible.

## Disposición

```text
0                 64              variable
┌─────────────────┬───────────────┬────────────┬─────────┬────────────┬───────────┐
│ Header FLXP v1  │ Manifest JSON │ Index JSON │ Payload │ Public key │ Signature │
└─────────────────┴───────────────┴────────────┴─────────┴────────────┴───────────┘
```

El manifiesto, índice y payload forman `signed_content`. `content_sha256` es SHA-256 de esa región. La firma ECDSA P-256 usa SHA-256 sobre la misma región.

## Encabezado fijo de 64 bytes

| Offset | Tamaño | Campo |
|---:|---:|---|
| 0 | 4 | Magic ASCII `FLXP` |
| 4 | 2 | Versión de formato, actualmente `1` |
| 6 | 2 | Flags, debe ser `0` |
| 8 | 4 | Longitud de manifiesto |
| 12 | 4 | Longitud de índice |
| 16 | 4 | Longitud de payload |
| 20 | 2 | Longitud de clave pública, debe ser `65` |
| 22 | 2 | Longitud de firma, debe ser `64` |
| 24 | 32 | SHA-256 de `signed_content` |
| 56 | 8 | Reservado, debe contener ceros |

La clave pública usa el punto X9.62 sin comprimir de secp256r1. La firma son dos enteros de 32 bytes `r || s`.

## Manifiesto

El JSON usa UTF-8, claves ordenadas, sin espacios innecesarios y sin BOM.

Campos obligatorios: `schema`, `id`, `name`, `version.name`, `version.code`, `minFlexOS`, `runtime`, `entry`, `permissions`, `developerKeySha256` y `limits`.

El runtime inicial es `flex-ui-1`. El ID usa tres o más segmentos, por ejemplo `dev.accountdev.hola_flex`.

## Índice

Lista canónica de objetos con `path`, `offset`, `size`, `sha256` y `mime`. Las rutas son relativas, usan `/` y nunca pueden contener `..`, barras invertidas ni duplicados.

## Límites de v1

- Paquete completo: 16 MB.
- Archivo individual: 8 MB.
- Archivos: 128.
- Manifiesto: 32 KB.
- Índice: 128 KB.
- Claves y firmas: únicamente ECDSA P-256.

## Instalación segura esperada en Flex Store

1. Descargar a un archivo temporal.
2. Validar encabezado, tamaños, SHA-256, todos los archivos y firma.
3. Comprobar compatibilidad y permisos.
4. Instalar en un slot temporal.
5. Activar la versión nueva mediante un cambio atómico.
6. Confirmar que inicia correctamente.
7. Eliminar el paquete y los archivos de la versión anterior.

Si cualquier comprobación falla, la versión instalada permanece intacta.
