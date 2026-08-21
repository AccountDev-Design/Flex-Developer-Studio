"""Deterministic Flex Package builder, inspector, and verifier."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

from .crypto import load_private_key, raw_public_key, sign_content, verify_signature
from .format import (
    FORMAT_VERSION,
    HEADER,
    MAGIC,
    MAX_FILE_BYTES,
    MAX_FILES,
    MAX_PACKAGE_BYTES,
    PackageError,
    canonical_json,
    is_safe_package_path,
    make_index_entry,
    parse_package,
    sha256_hex,
    validate_manifest,
)


def _read_manifest(project_dir: Path) -> dict[str, Any]:
    path = project_dir / "manifest.json"
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise PackageError(f"No existe {path}") from exc
    except json.JSONDecodeError as exc:
        raise PackageError(f"manifest.json inválido: {exc}") from exc
    if not isinstance(value, dict):
        raise PackageError("manifest.json debe contener un objeto JSON")
    return value


def _collect_files(project_dir: Path) -> list[tuple[str, bytes]]:
    output: list[tuple[str, bytes]] = []
    for path in sorted(project_dir.rglob("*")):
        relative = path.relative_to(project_dir)
        if path.is_symlink():
            raise PackageError(f"No se permiten enlaces simbólicos: {relative}")
        if not path.is_file() or relative.as_posix() == "manifest.json":
            continue
        if any(part.startswith(".") or part in {"dist", "build", "__pycache__"} for part in relative.parts):
            continue
        package_path = relative.as_posix()
        if not is_safe_package_path(package_path):
            raise PackageError(f"Ruta no segura: {package_path}")
        data = path.read_bytes()
        if len(data) > MAX_FILE_BYTES:
            raise PackageError(f"{package_path} supera el máximo de 8 MB")
        output.append((package_path, data))
    if not output:
        raise PackageError("El proyecto no contiene archivos para empaquetar")
    if len(output) > MAX_FILES:
        raise PackageError(f"El proyecto supera el máximo de {MAX_FILES} archivos")
    return output


def build_package(project_dir: Path, key_path: Path, output_path: Path | None = None) -> Path:
    project_dir = project_dir.expanduser().resolve()
    if not project_dir.is_dir():
        raise PackageError(f"No existe el proyecto: {project_dir}")
    manifest = _read_manifest(project_dir)
    key = load_private_key(key_path)
    public_key = raw_public_key(key)
    manifest["developerKeySha256"] = sha256_hex(public_key)
    manifest.setdefault("limits", {"memoryKB": 512, "storageKB": 256})
    validate_manifest(manifest)

    files = _collect_files(project_dir)
    payload_parts: list[bytes] = []
    index: list[dict[str, Any]] = []
    offset = 0
    for path, data in files:
        index.append(make_index_entry(path, offset, data))
        payload_parts.append(data)
        offset += len(data)
    payload = b"".join(payload_parts)
    manifest_bytes = canonical_json(manifest)
    index_bytes = canonical_json(index)
    signed_content = manifest_bytes + index_bytes + payload
    content_hash = hashlib.sha256(signed_content).digest()
    signature = sign_content(key, signed_content)
    header = HEADER.pack(MAGIC, FORMAT_VERSION, 0, len(manifest_bytes), len(index_bytes), len(payload), len(public_key), len(signature), content_hash, bytes(8))
    package = header + signed_content + public_key + signature
    if len(package) > MAX_PACKAGE_BYTES:
        raise PackageError("El .flexpkg final supera el máximo de 16 MB")

    if output_path is None:
        output_path = project_dir / "dist" / f"{manifest['id']}-{manifest['version']['name']}.flexpkg"
    output_path = output_path.expanduser().resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_bytes(package)
    verify_package(output_path)
    return output_path


def verify_package(path: Path) -> dict[str, Any]:
    try:
        blob = path.expanduser().read_bytes()
    except OSError as exc:
        raise PackageError(f"No se pudo leer el paquete: {path}") from exc
    parts = parse_package(blob, verify_files=True)
    verify_signature(parts.public_key, parts.signed_content, parts.signature)
    return {
        "path": str(path.expanduser().resolve()),
        "size": len(blob),
        "sha256": hashlib.sha256(blob).hexdigest(),
        "contentSha256": parts.content_sha256.hex(),
        "developerKeySha256": sha256_hex(parts.public_key),
        "manifest": parts.manifest,
        "files": parts.index,
        "signatureValid": True,
    }


def inspect_package(path: Path) -> dict[str, Any]:
    return verify_package(path)
