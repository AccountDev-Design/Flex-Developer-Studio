# Flex SDK 0.1.0

SDK oficial para crear paquetes `.flexpkg` firmados destinados a Flex OS Ultra.

## Instalación rápida en Windows

1. Instala Python 3.10 o superior.
2. Descomprime el SDK.
3. Ejecuta `setup_windows.bat` una sola vez.
4. Abre una terminal dentro de la carpeta.

## Primer proyecto

```powershell
flex keygen --out developer-key.pem
flex init mi-primera-app
flex build mi-primera-app --key developer-key.pem
flex verify mi-primera-app\dist\dev.tunombre.mi_app-1.0.0.flexpkg
```

La clave `developer-key.pem` identifica al desarrollador. No debe subirse a GitHub, enviarse por WhatsApp ni incluirse dentro de una app.

El paquete resultante contiene un encabezado binario `FLXP`, manifiesto canónico, índice de archivos, payload, clave pública P-256 y firma ECDSA. El constructor vuelve a verificar el paquete antes de considerarlo terminado.

## Comandos

- `flex init <carpeta>`: crea una app de ejemplo.
- `flex keygen --out <archivo>`: crea una clave ECDSA P-256.
- `flex build <proyecto> --key <clave>`: construye un `.flexpkg`.
- `flex verify <paquete>`: comprueba estructura, hashes y firma.
- `flex inspect <paquete>`: muestra el manifiesto y los archivos verificados.

Consulta [docs/FLEXPKG_SPEC.md](docs/FLEXPKG_SPEC.md) para la especificación binaria.
