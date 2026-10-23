"""Independent acceptance controls; these do not claim a real synthesis run."""
import importlib.util
import io
import math
from pathlib import Path
import struct
import unittest
import wave

module = importlib.util.spec_from_file_location("voice_ci_audio", Path(__file__).parents[1] / "scripts/voice-ci/audio.py")
audio = importlib.util.module_from_spec(module)
module.loader.exec_module(audio)


def wav(seconds=1, silent=False):
    result = io.BytesIO()
    with wave.open(result, "wb") as clip:
        clip.setnchannels(1)
        clip.setsampwidth(2)
        clip.setframerate(8000)
        clip.writeframes(b"".join(struct.pack("<h", 0 if silent else int(2000 * math.sin(i / 10)))
                                   for i in range(int(8000 * seconds))))
    return result.getvalue()


class VoiceAudioAcceptanceTests(unittest.TestCase):
    def test_real_sample_count_controls_duration(self):
        info = audio.inspect_wav(wav(20))
        self.assertEqual(info["durationSeconds"], 20)
        audio.check_duration(info["durationSeconds"], {"min": 18, "max": 40})
        with self.assertRaises(ValueError):
            audio.check_duration(audio.inspect_wav(wav(10))["durationSeconds"], {"min": 18, "max": 40})

    def test_empty_invalid_silent_and_truncated_responses_fail(self):
        for data in (b"", b"RIFFfake", wav(0), wav(silent=True), wav()[:-100]):
            with self.subTest(bytes=len(data)), self.assertRaises(ValueError):
                audio.inspect_wav(data)

    def test_transcript_normalization_and_edit_tolerance(self):
        result = audio.check_transcript("Before we leave, turn off the lights.",
                                        "Before we leave turn off the lights!", 0.18)
        self.assertEqual(result["wordErrorRate"], 0)
        with self.assertRaises(ValueError):
            audio.check_transcript("Before we leave, turn off the lights.", "Different content", 0.18)

    def test_tail_is_required_even_when_wer_is_small(self):
        prefix = "The complete recording has many words so losing one word is otherwise acceptable "
        with self.assertRaisesRegex(ValueError, "ending"):
            audio.check_transcript(prefix + "silver meadow lantern", prefix + "silver meadow", 0.18, "silver meadow lantern")

    def test_nan_duration_and_empty_asr_fail_closed(self):
        with self.assertRaises(ValueError):
            audio.check_duration(float('nan'), {"min": 18, "max": 40})
        with self.assertRaises(ValueError):
            audio.check_transcript("Expected words", "", 0.18)


class VoiceAdapterSchedulingTests(unittest.TestCase):
    def test_real_engine_busy_refusal_is_not_hidden_by_adapter_queue(self):
        import contextlib
        import json
        import sys
        import tempfile
        import threading
        import types
        import urllib.error
        import urllib.request
        from http.server import ThreadingHTTPServer
        from unittest.mock import patch
        from reverie.kokoro import Engine

        spec = importlib.util.spec_from_file_location("voice_ci_service", Path(__file__).parents[1] / "scripts/voice-ci/service.py")
        service = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {"audio": audio}):
            spec.loader.exec_module(service)
        entered, release = threading.Event(), threading.Event()
        class Samples:
            def __mul__(self, value): return self
            def astype(self, value): return self
            def tobytes(self): return b"\x01\x10" * 8000
        class Model:
            def create(self, *args, **kwargs):
                entered.set()
                if not release.wait(10): raise RuntimeError("test deadlock")
                return Samples(), 8000
        with tempfile.TemporaryDirectory() as tmp, patch.dict(sys.modules, {"numpy": types.SimpleNamespace(clip=lambda *a: Samples())}):
            root = Path(tmp); engine = Engine(root); engine.model = Model()
            engine.voices = [{"id": "am_michael", "language": "en-us"}]
            server = ThreadingHTTPServer(("127.0.0.1", 0), service.handler(engine, None, root, {"voice": "am_michael"}))
            thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
            url = f"http://127.0.0.1:{server.server_port}/tts"
            def request(): return urllib.request.Request(url, data=json.dumps({"text": "Hello", "voice": "am_michael"}).encode())
            result = []
            def first():
                with urllib.request.urlopen(request(), timeout=15) as response: result.append(response.read())
            client = threading.Thread(target=first)
            try:
                client.start(); self.assertTrue(entered.wait(5))
                with self.assertRaises(urllib.error.HTTPError) as error:
                    urllib.request.urlopen(request(), timeout=2)
                with contextlib.closing(error.exception) as response:
                    self.assertEqual(response.code, 503); self.assertIn("busy", json.load(response)["error"])
                release.set(); client.join(5); self.assertFalse(client.is_alive()); self.assertEqual(len(result), 1)
                events = [json.loads(line) for line in (root / "synth-events.jsonl").read_text().splitlines()]
                self.assertEqual([e["status"] for e in events], ["busy", "completed"])
                timing = events[1]["timing"]
                self.assertLessEqual(timing["lockAttemptNs"], timing["acquiredNs"])
                self.assertLessEqual(timing["acquiredNs"], timing["inferenceStartNs"])
                self.assertLess(timing["inferenceStartNs"], timing["inferenceEndNs"])
                self.assertLessEqual(timing["inferenceEndNs"], timing["finishedNs"])
            finally:
                release.set(); client.join(5); server.shutdown(); server.server_close(); thread.join(5)


    def test_adapter_disconnect_does_not_send_a_second_response_or_repeat_inference(self):
        import json
        import sys
        import tempfile
        from unittest.mock import patch
        spec = importlib.util.spec_from_file_location("voice_ci_service", Path(__file__).parents[1] / "scripts/voice-ci/service.py")
        service = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {"audio": audio}): spec.loader.exec_module(service)
        calls = []
        class Engine:
            def synthesize(self, body, **kwargs):
                calls.append(body); return wav()
        with tempfile.TemporaryDirectory() as tmp:
            handler = service.handler(Engine(), None, Path(tmp), {"voice": "am_michael"})
            request = object.__new__(handler)
            body = json.dumps({"text": "Hello", "voice": "am_michael"}).encode()
            request.headers = {"Content-Length": str(len(body))}; request.path = "/tts"; request.rfile = io.BytesIO(body)
            sends = []
            def disconnected(*args):
                sends.append(args); raise BrokenPipeError("client cancelled")
            request.send = disconnected
            handler.do_POST(request)
            self.assertEqual(len(calls), 1); self.assertEqual(len(sends), 1)

    def test_inference_telemetry_requires_finite_ordered_real_stage_times(self):
        import sys
        from unittest.mock import patch
        spec = importlib.util.spec_from_file_location("voice_ci_verify", Path(__file__).parents[1] / "scripts/voice-ci/verify.py")
        verify = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {"audio": audio}): spec.loader.exec_module(verify)
        timing = dict(status="completed", lockAttemptNs=2, acquiredNs=3, inferenceStartNs=4, inferenceEndNs=5, finishedNs=6)
        event = dict(status="completed", requestNs=1, responseNs=7, timing=timing)
        verify.check_synthesis_timing(event)
        for changed in ({"inferenceEndNs": 3}, {"acquiredNs": float('nan')}, {"inferenceStartNs": True}, {"status": "busy"}, {"finishedNs": 8}):
            with self.subTest(changed=changed), self.assertRaises(ValueError):
                verify.check_synthesis_timing({**event, "timing": {**timing, **changed}})
        with self.assertRaises(ValueError): verify.check_synthesis_timing({**event, "timing": {}})
