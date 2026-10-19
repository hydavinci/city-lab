from pathlib import Path
from tempfile import TemporaryDirectory


def publish_manifest(package, text):
    immutable = package / "manifest.json"
    if immutable.exists():
        if immutable.read_text(encoding="utf-8") != text:
            raise ValueError("Refusing to overwrite an immutable package manifest")
    else:
        immutable.write_text(text, encoding="utf-8")
    with TemporaryDirectory(prefix=".publish-", dir=package.parent) as directory:
        staged = Path(directory) / "manifest.json"
        staged.write_text(text, encoding="utf-8")
        staged.replace(package.parent / "manifest.json")
