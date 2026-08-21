"""Command-line interface for Flex SDK."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

from .builder import build_package, inspect_package, verify_package
from .crypto import generate_private_key
from .format import PackageError


SAMPLE_MANIFEST = {
    "schema": 1,
    "id": "dev.tunombre.mi_app",
    "name": "Mi primera app",
    "version": {"name": "1.0.0", "code": 1},
    "minFlexOS": "1.0.0",
    "runtime": "flex-ui-1",
    "entry": "app/main.flex.json",
    "category": "Herramientas",
    "summary": "Mi primera aplicación para Flex OS",
    "permissions": [],
    "limits": {"memoryKB": 512, "storageKB": 256},
}
SAMPLE_APP = {
    "schema": 1,
    "theme": {"background": "#0B0D16", "accent": "#806BFF"},
    "startScreen": "home",
    "screens": [{
        "id": "home",
        "title": "Mi primera app",
        "components": [
            {"type": "text", "id": "welcome", "text": "¡Hola desde Flex OS!", "x": 28, "y": 110, "width": 424, "style": "title"},
            {"type": "button", "id": "hello", "text": "Tócame", "x": 28, "y": 200, "width": 180, "height": 52, "action": {"type": "notify", "message": "La app funciona correctamente"}},
        ],
    }],
}


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="flex", description="Flex SDK · crea paquetes .flexpkg firmados")
    parser.add_argument("--version", action="version", version="Flex SDK 0.1.0")
    commands = parser.add_subparsers(dest="command", required=True)
    init = commands.add_parser("init", help="Crea un proyecto Flex nuevo")
    init.add_argument("directory", type=Path)
    keygen = commands.add_parser("keygen", help="Genera una clave ECDSA P-256")
    keygen.add_argument("--out", type=Path, default=Path("developer-key.pem"))
    keygen.add_argument("--force", action="store_true")
    build = commands.add_parser("build", help="Construye y firma un .flexpkg")
    build.add_argument("project", type=Path)
    build.add_argument("--key", type=Path, required=True)
    build.add_argument("--out", type=Path)
    verify = commands.add_parser("verify", help="Verifica hashes, estructura y firma")
    verify.add_argument("package", type=Path)
    inspect = commands.add_parser("inspect", help="Muestra el contenido validado")
    inspect.add_argument("package", type=Path)
    return parser


def _init_project(directory: Path) -> None:
    directory = directory.expanduser().resolve()
    if directory.exists() and any(directory.iterdir()):
        raise PackageError(f"La carpeta no está vacía: {directory}")
    (directory / "app").mkdir(parents=True, exist_ok=True)
    (directory / "assets").mkdir(exist_ok=True)
    (directory / "manifest.json").write_text(json.dumps(SAMPLE_MANIFEST, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (directory / "app" / "main.flex.json").write_text(json.dumps(SAMPLE_APP, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"✓ Proyecto creado en {directory}")
    print("  Edita manifest.json y app/main.flex.json antes de compilar.")


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        if args.command == "init":
            _init_project(args.directory)
        elif args.command == "keygen":
            path = generate_private_key(args.out, force=args.force)
            print(f"✓ Clave creada: {path}")
            print("  No publiques ni compartas este archivo.")
        elif args.command == "build":
            path = build_package(args.project, args.key, args.out)
            details = verify_package(path)
            print(f"✓ Flex Package creado: {path}")
            print(f"  Tamaño: {details['size']} bytes")
            print(f"  SHA-256: {details['sha256']}")
        elif args.command == "verify":
            details = verify_package(args.package)
            print("✓ Paquete válido y firma ECDSA verificada")
            print(f"  App: {details['manifest']['name']} {details['manifest']['version']['name']}")
            print(f"  SHA-256: {details['sha256']}")
        elif args.command == "inspect":
            print(json.dumps(inspect_package(args.package), ensure_ascii=False, indent=2))
        return 0
    except PackageError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
