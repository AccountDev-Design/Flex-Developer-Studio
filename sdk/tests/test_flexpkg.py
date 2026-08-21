from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest

from flexsdk.builder import build_package, verify_package
from flexsdk.crypto import generate_private_key
from flexsdk.format import PackageError


class FlexPackageTests(unittest.TestCase):
    def make_project(self, root: Path) -> Path:
        project = root / "app"
        (project / "app").mkdir(parents=True)
        manifest = {
            "schema": 1,
            "id": "dev.test.hello",
            "name": "Hello",
            "version": {"name": "1.0.0", "code": 1},
            "minFlexOS": "1.0.0",
            "runtime": "flex-ui-1",
            "entry": "app/main.flex.json",
            "permissions": [],
            "limits": {"memoryKB": 256, "storageKB": 64},
        }
        (project / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
        (project / "app" / "main.flex.json").write_text('{"schema":1,"screens":[]}', encoding="utf-8")
        return project

    def test_build_and_verify(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            project = self.make_project(root)
            key = generate_private_key(root / "developer.pem")
            package = build_package(project, key)
            result = verify_package(package)
            self.assertTrue(result["signatureValid"])
            self.assertEqual(result["manifest"]["id"], "dev.test.hello")
            self.assertEqual(result["files"][0]["path"], "app/main.flex.json")

    def test_tampering_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            project = self.make_project(root)
            key = generate_private_key(root / "developer.pem")
            package = build_package(project, key)
            damaged = bytearray(package.read_bytes())
            damaged[80] ^= 1
            package.write_bytes(damaged)
            with self.assertRaises(PackageError):
                verify_package(package)


if __name__ == "__main__":
    unittest.main()
