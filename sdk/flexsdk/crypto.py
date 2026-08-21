"""P-256 developer key generation and Flex Package signatures."""

from __future__ import annotations

from pathlib import Path

from .format import PackageError

try:
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature, encode_dss_signature
    from cryptography.exceptions import InvalidSignature
except ImportError as exc:  # pragma: no cover
    raise RuntimeError("Falta 'cryptography'. Ejecuta: pip install -r requirements.txt") from exc


def generate_private_key(path: Path, *, force: bool = False) -> Path:
    path = path.expanduser().resolve()
    if path.exists() and not force:
        raise PackageError(f"La clave ya existe: {path}. Usa --force solo si deseas reemplazarla.")
    path.parent.mkdir(parents=True, exist_ok=True)
    key = ec.generate_private_key(ec.SECP256R1())
    path.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    try:
        path.chmod(0o600)
    except OSError:
        pass
    return path


def load_private_key(path: Path) -> ec.EllipticCurvePrivateKey:
    try:
        key = serialization.load_pem_private_key(path.expanduser().read_bytes(), password=None)
    except (OSError, ValueError, TypeError) as exc:
        raise PackageError(f"No se pudo leer la clave privada: {path}") from exc
    if not isinstance(key, ec.EllipticCurvePrivateKey) or not isinstance(key.curve, ec.SECP256R1):
        raise PackageError("La clave debe ser ECDSA P-256 (secp256r1)")
    return key


def raw_public_key(key: ec.EllipticCurvePrivateKey) -> bytes:
    return key.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)


def sign_content(key: ec.EllipticCurvePrivateKey, content: bytes) -> bytes:
    der = key.sign(content, ec.ECDSA(hashes.SHA256()))
    r, s = decode_dss_signature(der)
    return r.to_bytes(32, "big") + s.to_bytes(32, "big")


def verify_signature(public_key_bytes: bytes, content: bytes, signature: bytes) -> None:
    if len(signature) != 64:
        raise PackageError("La firma debe tener 64 bytes")
    try:
        key = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), public_key_bytes)
        der = encode_dss_signature(int.from_bytes(signature[:32], "big"), int.from_bytes(signature[32:], "big"))
        key.verify(der, content, ec.ECDSA(hashes.SHA256()))
    except (ValueError, InvalidSignature) as exc:
        raise PackageError("Firma ECDSA inválida; el paquete no es confiable") from exc
