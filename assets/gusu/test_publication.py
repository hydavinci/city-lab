from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from publication import publish_manifest


class ManifestPublicationTests(unittest.TestCase):
    def test_replaces_pointer_only_after_complete_package_manifest(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            package = root / "package"
            package.mkdir()
            pointer = root / "manifest.json"
            pointer.write_text("old")
            replace = Path.replace

            def observe(source, destination):
                self.assertEqual(pointer.read_text(), "old")
                self.assertEqual((package / "manifest.json").read_text(), "new")
                self.assertEqual(source.read_text(), "new")
                return replace(source, destination)

            with patch.object(Path, "replace", observe):
                publish_manifest(package, "new")
            self.assertEqual(pointer.read_text(), "new")
            self.assertEqual(sorted(p.name for p in root.iterdir()), ["manifest.json", "package"])
            original = (package / "manifest.json").stat().st_mtime_ns
            publish_manifest(package, "new")
            self.assertEqual((package / "manifest.json").stat().st_mtime_ns, original)

    def test_failed_pointer_replace_preserves_old_pointer_and_cleans_staging(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            package = root / "package"
            package.mkdir()
            (root / "manifest.json").write_text("old")
            with patch.object(Path, "replace", side_effect=OSError("injected rename failure")):
                with self.assertRaisesRegex(OSError, "injected rename failure"):
                    publish_manifest(package, "new")
            self.assertEqual((root / "manifest.json").read_text(), "old")
            self.assertEqual(sorted(p.name for p in root.iterdir()), ["manifest.json", "package"])

    def test_rejects_changes_to_an_immutable_package_manifest(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            package = root / "package"
            package.mkdir()
            (package / "manifest.json").write_text("immutable")
            (root / "manifest.json").write_text("old")
            with self.assertRaisesRegex(ValueError, "immutable"):
                publish_manifest(package, "different")
            self.assertEqual((package / "manifest.json").read_text(), "immutable")
            self.assertEqual((root / "manifest.json").read_text(), "old")


if __name__ == "__main__":
    unittest.main()
