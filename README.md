# Flex Developer Studio

Plataforma oficial para crear, firmar y publicar aplicaciones para Flex OS Ultra.

- Sitio público: https://flex-developer-studio.ralvarezsantos980.chatgpt.site
- Flex SDK: `sdk/`
- Flex Cloud (servicio + web): `cloud/` — ver [cloud/README.md](cloud/README.md)
- Formato firmado: `.flexpkg` / FLXP v1
- Objetivo de hardware: ESP32-P4 con Flex OS Ultra

## Flex SDK

```powershell
cd sdk
setup_windows.bat
flex keygen --out developer-key.pem
flex init mi-primera-app
flex build mi-primera-app --key developer-key.pem
```

Cada paquete incluye hashes SHA-256 por archivo y firma ECDSA P-256. Consulta [la especificación](sdk/docs/FLEXPKG_SPEC.md).

## Flex Cloud

Almacenamiento en la nube del ecosistema (5 GB por cuenta, configurable), con la
misma Flex Account en la web y en Flex OS Ultra. Archivos originales sin
recomprimir, subidas reanudables y descargas por rangos.

```bash
cd cloud
npm run dev     # web y API en http://127.0.0.1:8787 (modo desarrollo)
npm test
```
