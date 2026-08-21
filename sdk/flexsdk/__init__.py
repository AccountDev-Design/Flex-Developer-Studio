"""Flex SDK public package API."""

from .builder import build_package, inspect_package, verify_package
from .format import FORMAT_VERSION, MAGIC, PackageError

__all__ = [
    "FORMAT_VERSION",
    "MAGIC",
    "PackageError",
    "build_package",
    "inspect_package",
    "verify_package",
]

__version__ = "0.1.0"
