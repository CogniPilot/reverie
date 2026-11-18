"""Kokoro service boundaries; real model/audio smoke checks run from the Nix package."""
import hashlib
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from reverie import kokoro


class ModelTests(unittest.TestCase):
    def test_download_is_verified_and_cached_without_another_request(self):
        body = b"pinned model content"
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            with patch.dict(kokoro.MODELS, {"test.bin": hashlib.sha256(body).hexdigest()}, clear=True), \
                 patch.object(kokoro.urllib.request, "urlopen", return_value=io.BytesIO(body)) as request:
                kokoro.ensure_models(directory)
                kokoro.ensure_models(directory)
                self.assertEqual(request.call_count, 1)
                self.assertEqual((directory / "test.bin").stat().st_mode & 0o777, 0o600)

    def test_bad_download_never_becomes_a_model_and_partial_is_removed(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            with patch.dict(kokoro.MODELS, {"test.bin": "0" * 64}, clear=True), \
                 patch.object(kokoro.urllib.request, "urlopen", return_value=io.BytesIO(b"corrupt")):
                with self.assertRaisesRegex(ValueError, "checksum mismatch"):
                    kokoro.ensure_models(directory)
                self.assertFalse((directory / "test.bin").exists())
                self.assertFalse((directory / "test.bin.part").exists())

    def test_damaged_cached_model_is_not_overwritten(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            (directory / "test.bin").write_bytes(b"damaged")
            with patch.dict(kokoro.MODELS, {"test.bin": "0" * 64}, clear=True), \
                 patch.object(kokoro.urllib.request, "urlopen") as request:
                with self.assertRaisesRegex(ValueError, "checksum mismatch"):
                    kokoro.ensure_models(directory)
                request.assert_not_called()
                self.assertEqual((directory / "test.bin").read_bytes(), b"damaged")

    def test_catalog_reports_only_supported_languages_with_editable_selection_tags(self):
        result = kokoro.voice_options(["af_heart", "bm_george", "jf_alpha", "unknown"], {"en-us", "en-gb"})
        self.assertEqual([v["id"] for v in result], ["af_heart", "bm_george"])
        self.assertEqual(result[0]["gender"], "feminine")
        self.assertEqual(result[1]["language"], "en-gb")
