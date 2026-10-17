import tests  # noqa: F401  isolates CODEMAN_*/FLEET_* before cto is imported
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REQUIREMENTS = ROOT / "docker" / "image-requirements.txt"
CONTAINERFILE = ROOT / "docker" / "Containerfile"


class ImageRequirementsTests(unittest.TestCase):
    """Extra Python packages in the image are exact versions with wheel hashes, installed binary-only and smoke-tested."""

    def test_every_package_is_pinned_by_version_and_hash(self):
        lines = [l.strip() for l in REQUIREMENTS.read_text().splitlines() if l.strip() and not l.lstrip().startswith("#")]
        self.assertTrue(lines)
        for line in lines:
            self.assertRegex(line, r"^[A-Za-z0-9._-]+==[0-9][0-9A-Za-z.]*( --hash=sha256:[0-9a-f]{64})+$", line)
        self.assertIn("pillow==11.3.0", " ".join(lines))

    def test_the_image_installs_them_hash_checked_binary_only_and_smoke_tests_pillow(self):
        text = CONTAINERFILE.read_text()
        self.assertIn("COPY docker/image-requirements.txt ./docker/image-requirements.txt", text)
        install = re.search(r"pip install [^\n]*-r \./docker/image-requirements\.txt", text)
        self.assertIsNotNone(install)
        for flag in ("--require-hashes", "--only-binary=:all:", "--no-cache-dir"):
            self.assertIn(flag, install.group(0))
        smoke = re.search(r'python3 -I -c "from PIL import Image, ImageDraw;[^"]*"', text)
        self.assertIsNotNone(smoke)
        for step in (".save('/tmp/pil-smoke.png')", ".save('/tmp/pil-smoke.webp')", "assert Image.open"):
            self.assertIn(step, smoke.group(0))
        # the smoke step runs in the same RUN as the install, after it
        run = text[text.index("RUN python3 -m venv /opt/fleet/python"):]
        run = run[:run.index("\nENV ")]
        self.assertLess(run.index("--require-hashes"), run.index("from PIL import"))


if __name__ == "__main__": unittest.main()
