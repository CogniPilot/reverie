"""Kokoro service boundaries; real model/audio smoke checks run from the Nix package."""
import hashlib
from http.server import ThreadingHTTPServer
import io
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
import urllib.error
import urllib.request

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


class ServiceTests(unittest.TestCase):
    def setUp(self):
        class FakeEngine:
            model = object()
            error = False
            voices = [{"id": "af_heart", "language": "en-us"}]

            def synthesize(self, payload):
                if payload.get("voice") != "af_heart":
                    raise ValueError("Unknown or unsupported voice")
                return b"RIFFtest-wave"

        self.engine = FakeEngine()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), kokoro.handler(self.engine))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def test_ready_catalog_and_raw_audio_match_console_contract(self):
        with urllib.request.urlopen(self.base + "/voices") as response:
            self.assertEqual(json.load(response)["voices"][0]["id"], "af_heart")
        request = urllib.request.Request(self.base + "/tts", data=json.dumps({"voice": "af_heart", "text": "Hello"}).encode())
        with urllib.request.urlopen(request) as response:
            self.assertEqual(response.headers["Content-Type"], "audio/wav")
            self.assertTrue(response.read().startswith(b"RIFF"))

    def test_loading_service_does_not_advertise_available_voices(self):
        self.engine.model = None
        with self.assertRaises(urllib.error.HTTPError) as error:
            urllib.request.urlopen(self.base + "/voices")
        self.assertEqual(error.exception.code, 503)

    def test_invalid_voice_and_non_object_body_are_rejected(self):
        for body in [{"voice": "../../anything", "text": "Hello"}, []]:
            request = urllib.request.Request(self.base + "/tts", data=json.dumps(body).encode())
            with self.assertRaises(urllib.error.HTTPError) as error:
                urllib.request.urlopen(request)
            self.assertEqual(error.exception.code, 400)


if __name__ == "__main__":
    unittest.main()
