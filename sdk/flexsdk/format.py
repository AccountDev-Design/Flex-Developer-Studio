"""Binary layout and strict parser for Flex Package format v1."""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import mimetypes
import re
import struct
from typing import Any

MAGIC = b"FLXP"
FORMAT_VERSION = 1
HEADER_SIZE = 64
MAX_PACKAGE_BYTES = 16 * 1024 * 1024
MAX_FILE_BYTES = 8 * 1024 * 1024
MAX_FILES = 128
MAX_MANIFEST_BYTES = 32 * 1024
MAX_INDEX_BYTES = 128 * 1024

# magic, format, flags, manifest, index, payload, pubkey, signature, content hash, reserved
HEADER = struct.Struct("<4sHHIIIHH32s8s")
ALLOWED_PERMISSIONS = {
    "network",
    "storage.read",
    "storage.write",
    "notifications",
    "camera",
    "microphone",
    "location",
    "clipboard",
}
ID_PATTERN = re.compile(r"^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*){2,7}$")
VERSION_PATTERN = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.-]+)?$")
SAFE_PATH_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]{0,239}$")


class PackageError(ValueError):
    """Raised when a package is malformed, unsafe, or unverifiable."""


@dataclass(frozen=True)
class PackageParts:
    manifest: dict[str, Any]
    index: list[dict[str, Any]]
    manifest_bytes: bytes
    index_bytes: bytes
    payload: bytes
    public_key: bytes
    signature: bytes
    content_sha256: bytes
    signed_content: bytes


def canonical_json(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def sha256_hex(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def is_safe_package_path(path: str) -> bool:
    if not SAFE_PATH_PATTERN.fullmatch(path):
        return False
    if path.startswith(("/", "./")) or "\\" in path:
        return False
    return all(part not in ("", ".", "..") for part in path.split("/"))


def validate_manifest(manifest: dict[str, Any]) -> None:
    required = ("schema", "id", "name", "version", "minFlexOS", "runtime", "entry", "permissions")
    for key in required:
        if key not in manifest:
            raise PackageError(f"manifest.json: falta '{key}'")
    if manifest["schema"] != 1:
        raise PackageError("manifest.json: schema debe ser 1")
    if not isinstance(manifest["id"], str) or not ID_PATTERN.fullmatch(manifest["id"]):
        raise PackageError("manifest.json: id inválido; usa dev.nombre.app")
    if not isinstance(manifest["name"], str) or not 2 <= len(manifest["name"].strip()) <= 60:
        raise PackageError("manifest.json: name debe tener entre 2 y 60 caracteres")
    version = manifest["version"]
    if not isinstance(version, dict) or not VERSION_PATTERN.fullmatch(str(version.get("name", ""))):
        raise PackageError("manifest.json: version.name debe usar formato 1.0.0")
    if not isinstance(version.get("code"), int) or version["code"] < 1:
        raise PackageError("manifest.json: version.code debe ser un entero positivo")
    if not VERSION_PATTERN.fullmatch(str(manifest["minFlexOS"])):
        raise PackageError("manifest.json: minFlexOS debe usar formato 1.0.0")
    if manifest["runtime"] != "flex-ui-1":
        raise PackageError("manifest.json: runtime no compatible; se requiere flex-ui-1")
    if not isinstance(manifest["entry"], str) or not is_safe_package_path(manifest["entry"]):
        raise PackageError("manifest.json: entry no es una ruta segura")
    permissions = manifest["permissions"]
    if not isinstance(permissions, list) or len(permissions) > 16 or len(set(permissions)) != len(permissions):
        raise PackageError("manifest.json: permissions debe ser una lista sin duplicados")
    unknown = set(permissions) - ALLOWED_PERMISSIONS
    if unknown:
        raise PackageError(f"manifest.json: permisos desconocidos: {', '.join(sorted(unknown))}")
    limits = manifest.get("limits", {})
    if not isinstance(limits, dict):
        raise PackageError("manifest.json: limits debe ser un objeto")
    memory_kb = limits.get("memoryKB", 512)
    storage_kb = limits.get("storageKB", 256)
    if not isinstance(memory_kb, int) or not 64 <= memory_kb <= 4096:
        raise PackageError("manifest.json: limits.memoryKB debe estar entre 64 y 4096")
    if not isinstance(storage_kb, int) or not 0 <= storage_kb <= 8192:
        raise PackageError("manifest.json: limits.storageKB debe estar entre 0 y 8192")


def make_index_entry(path: str, offset: int, data: bytes) -> dict[str, Any]:
    mime = mimetypes.guess_type(path)[0] or "application/octet-stream"
    return {"path": path, "offset": offset, "size": len(data), "sha256": sha256_hex(data), "mime": mime}


def parse_package(blob: bytes, *, verify_files: bool = True) -> PackageParts:
    if len(blob) < HEADER_SIZE:
        raise PackageError("El archivo es demasiado pequeño para ser un .flexpkg")
    if len(blob) > MAX_PACKAGE_BYTES:
        raise PackageError("El paquete supera el máximo de 16 MB")
    magic, format_version, flags, manifest_len, index_len, payload_len, public_key_len, signature_len, expected_hash, reserved = HEADER.unpack_from(blob)
    if magic != MAGIC:
        raise PackageError("Firma de archivo inválida: no es un Flex Package")
    if format_version != FORMAT_VERSION:
        raise PackageError(f"Versión de formato no compatible: {format_version}")
    if flags != 0 or reserved != bytes(8):
        raise PackageError("El encabezado usa flags o bytes reservados no compatibles")
    if not 1 <= manifest_len <= MAX_MANIFEST_BYTES:
        raise PackageError("Tamaño de manifiesto inválido")
    if not 2 <= index_len <= MAX_INDEX_BYTES:
        raise PackageError("Tamaño de índice inválido")
    if payload_len > MAX_PACKAGE_BYTES or public_key_len != 65 or signature_len != 64:
        raise PackageError("Longitudes criptográficas o de payload inválidas")

    content_start = HEADER_SIZE
    manifest_end = content_start + manifest_len
    index_end = manifest_end + index_len
    payload_end = index_end + payload_len
    public_key_end = payload_end + public_key_len
    signature_end = public_key_end + signature_len
    if signature_end != len(blob):
        raise PackageError("El tamaño declarado no coincide con el archivo")

    manifest_bytes = blob[content_start:manifest_end]
    index_bytes = blob[manifest_end:index_end]
    payload = blob[index_end:payload_end]
    public_key = blob[payload_end:public_key_end]
    signature = blob[public_key_end:signature_end]
    signed_content = blob[content_start:payload_end]
    actual_hash = hashlib.sha256(signed_content).digest()
    if actual_hash != expected_hash:
        raise PackageError("SHA-256 del contenido no coincide; el paquete fue alterado")

    try:
        manifest = json.loads(manifest_bytes.decode("utf-8"))
        index = json.loads(index_bytes.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise PackageError("El manifiesto o índice no contiene JSON UTF-8 válido") from exc
    if not isinstance(manifest, dict) or not isinstance(index, list):
        raise PackageError("Estructura de manifiesto o índice inválida")
    if canonical_json(manifest) != manifest_bytes or canonical_json(index) != index_bytes:
        raise PackageError("El manifiesto y el índice deben usar JSON canónico")
    validate_manifest(manifest)
    if len(index) > MAX_FILES:
        raise PackageError(f"El paquete supera el máximo de {MAX_FILES} archivos")

    paths: set[str] = set()
    last_end = 0
    for entry in index:
        if not isinstance(entry, dict):
            raise PackageError("Entrada de índice inválida")
        path = entry.get("path")
        offset = entry.get("offset")
        size = entry.get("size")
        file_hash = entry.get("sha256")
        if not isinstance(path, str) or not is_safe_package_path(path) or path in paths:
            raise PackageError("El índice contiene una ruta inválida o duplicada")
        if not isinstance(offset, int) or not isinstance(size, int) or offset < 0 or size < 0 or size > MAX_FILE_BYTES:
            raise PackageError(f"Offset o tamaño inválido en {path}")
        if offset < last_end or offset + size > len(payload):
            raise PackageError(f"Rango de payload inválido en {path}")
        if not isinstance(file_hash, str) or not re.fullmatch(r"[0-9a-f]{64}", file_hash):
            raise PackageError(f"SHA-256 inválido en {path}")
        if verify_files and sha256_hex(payload[offset:offset + size]) != file_hash:
            raise PackageError(f"SHA-256 no coincide en {path}")
        paths.add(path)
        last_end = offset + size
    if last_end != len(payload) and index:
        raise PackageError("El payload contiene bytes no declarados")
    if manifest["entry"] not in paths:
        raise PackageError("El archivo entry del manifiesto no existe en el paquete")
    expected_fingerprint = manifest.get("developerKeySha256")
    if not isinstance(expected_fingerprint, str) or expected_fingerprint != sha256_hex(public_key):
        raise PackageError("La huella de la clave del desarrollador no coincide")

    return PackageParts(manifest, index, manifest_bytes, index_bytes, payload, public_key, signature, actual_hash, signed_content)
