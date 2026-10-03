# Flex Cloud

Almacenamiento en la nube del ecosistema Flex: la web de Flex Developer Studio
y Flex OS Ultra (ESP32-P4) usan **la misma cuenta (Flex Account), la misma API
y los mismos archivos**.

- 5 GB por cuenta de serie, configurable por planes (10/50/100 GB preparados).
- Archivos **originales**: sin recomprimir, sin reescalar, verificados con SHA-256.
- Subidas por partes reanudables (corte de Wi-Fi, recarga, reinicio del servidor).
- Descargas y vídeo por rangos (`Range`), sin cargar el archivo entero.
- Carpetas, papelera con restauración, búsqueda, miniaturas, enlaces temporales.

## Dónde se abre

- En Flex Developer Studio: **`/cloud/`** (ruta fija; `/cloud` redirige). El
  servicio la sirve él mismo, también sin proxy en `http://127.0.0.1:8787/cloud/`.
- Dentro de la web hay una **Ayuda** (icono ? arriba y «Ayuda» en la barra
  lateral): guía rápida de subir, carpetas, descargar, verlo desde Flex OS,
  qué cuenta del almacenamiento y qué hacer si la cuenta se desvincula.
- En el P4: Archivos › Flex Cloud, y la pestaña Nube de Galería y Multimedia.

## Ejecutar

Requiere Node.js ≥ 22.13. Sin `npm install`: no tiene dependencias de ejecución.

```bash
cd cloud
npm run dev        # http://127.0.0.1:8787 · Flex Account en modo desarrollo
```

Producción (detrás del mismo dominio que Flex Developer Studio):

```bash
NODE_ENV=production \
FLEX_CLOUD_SECRET=<32+ caracteres aleatorios> \
FLEX_ACCOUNT_INTROSPECT_URL=https://flex-developer-studio…/api/internal/introspect \
FLEX_ACCOUNT_SERVICE_KEY=<clave de servicio compartida> \
FLEX_CLOUD_PUBLIC_URL=https://flex-developer-studio… \
FLEX_CLOUD_DATA_DIR=/var/lib/flex-cloud \
FLEX_CLOUD_TRUST_PROXY=1 \
npm start
```

| Variable | Por defecto | |
|---|---|---|
| `FLEX_CLOUD_PLANS` | `{"free":5GiB,"plus":10GiB,"pro":50GiB,"max":100GiB}` | Cuotas por plan (bytes) |
| `FLEX_CLOUD_DEFAULT_PLAN` | `free` | Plan de una cuenta nueva |
| `FLEX_CLOUD_CHUNK_BYTES` | 8 MiB | Parte por defecto (64 KiB … 64 MiB) |
| `FLEX_CLOUD_MAX_FILE_BYTES` | 50 GiB | Tamaño máximo de un archivo |
| `FLEX_CLOUD_UPLOAD_TTL_HOURS` | 72 | Caducidad de una subida inactiva |
| `FLEX_CLOUD_TRASH_DAYS` | 30 | Días en la papelera antes de borrarse |
| `FLEX_CLOUD_LINK_MINUTES` | 15 | Vida de un enlace firmado |
| `FLEX_ACCOUNT_MODE` | `remote` (prod) / `dev` | `dev` está prohibido en producción |

## Pruebas

```bash
npm test             # API, cuota, papelera, subidas, rangos, seguridad, Flex Account, ruta /cloud/, ayuda y SHA-256 sin crypto.subtle (62)
npm run test:large   # 10 / 50 / 160 / 500 MB con corte, reanudación y rangos
npm run test:e2e     # la web en Chromium (Playwright): 28 comprobaciones
npm run check        # sintaxis + la web solo carga scripts propios
```

## Documentación

- [API](docs/API.md)
- [Arquitectura y decisiones](docs/ARCHITECTURE.md)
- [Integración con Flex Account](docs/FLEX_ACCOUNT_INTEGRATION.md)

El firmware de Flex OS Ultra (cliente nativo de Flex Cloud) vive en el
repositorio **Flex-OS-Ecosistema**, no aquí.
