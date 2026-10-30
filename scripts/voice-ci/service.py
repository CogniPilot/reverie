"""Loopback-only CI adapter: real Kokoro TTS and Whisper ASR, no agent/LLM.

The /tts protocol differences are intentional: /voice/speak asks for a raw WAV
with an explicit voice; /voice/turn asks its configured service for an audio URL.
The latter uses this fixture service's fixed am_michael default, not a claim that
the production turn route forwards employee voice settings.
"""
from __future__ import annotations

import argparse
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import tempfile
import threading
import time
import uuid

from audio import inspect_wav
from reverie.kokoro import Engine, MODELS


WHISPER_SHA256 = "d3dd57d32accea0b295c96e26691aa14d8822fac7d9d27d5dc00b4ca2826dd03"


def handler(engine, recognizer, root, fixture):
    audio: dict[str, bytes] = {}
    asr_lock = threading.Lock()
    record_lock = threading.Lock()

    def record(event):
        with record_lock, (root / "synth-events.jsonl").open("a") as stream:
            stream.write(json.dumps(event) + "\n")

    def record_request(phase, request, timing):
        # Keep starts separately: the completion-only acceptance stream must
        # not mistake an interrupted request for a successful synthesis.
        event = {**request, "phase": phase, "atNs": time.monotonic_ns(),
                 "processCpuNs": time.process_time_ns(), "timing": dict(timing)}
        with record_lock, (root / "speech-requests.jsonl").open("a") as stream:
            stream.write(json.dumps(event) + "\n")

    class RequestTiming(dict):
        def __init__(self, request):
            super().__init__()
            self.request = request

        def __setitem__(self, key, value):
            super().__setitem__(key, value)
            # Engine writes these around model.create. Retain them immediately
            # even if the client deadline later ends the fixture process.
            if key in {"inferenceStartNs", "inferenceEndNs"}:
                phase = "inference-start" if key == "inferenceStartNs" else "inference-end"
                record_request(phase, self.request, self)

    class Handler(BaseHTTPRequestHandler):
        def setup(self):
            super().setup()
            self.connection.settimeout(120)

        def send(self, code, body, kind="application/json"):
            data = body if isinstance(body, bytes) else json.dumps(body).encode()
            self.send_response(code)
            self.send_header("Content-Type", kind)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            if self.path == "/health":
                return self.send(200, {"status": "ok", "stt": "ready", "tts": "ready"})
            if self.path == "/voices":
                return self.send(200, {"voices": engine.voices})
            if self.path.startswith("/audio/") and self.path[7:] in audio:
                return self.send(200, audio[self.path[7:]], "audio/wav")
            return self.send(404, {"error": "No fixture resource"})

        def do_POST(self):
            started = time.monotonic_ns()
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= 10 * 1024 * 1024:
                    return self.send(413, {"error": "Fixture request too large or empty"})
                body = self.rfile.read(length)
                if self.path == "/stt":
                    with asr_lock, tempfile.NamedTemporaryFile(suffix=".wav", dir=root) as clip:
                        clip.write(body)
                        clip.flush()
                        result = recognizer.transcribe(clip.name, language="en", fp16=False,
                                                       temperature=0, condition_on_previous_text=False)
                    return self.send(200, {"transcript": result["text"].strip()})
                if self.path != "/tts":
                    return self.send(404, {"error": "No fixture operation"})
                payload = json.loads(body)
                requested = payload.get("voice")
                selected = requested or fixture["voice"]
                text = payload["text"]
                request = {"requestId": uuid.uuid4().hex, "requestNs": started,
                           "effectiveVoice": selected,
                           "textCharacters": len(text) if isinstance(text, str) else None,
                           "textSha256": hashlib.sha256(text.encode("utf-8", "surrogatepass")).hexdigest()
                           if isinstance(text, str) else None}
                timing = RequestTiming(request)
                record_request("synthesis-start", request, timing)
                phase = "synthesis-raised"
                try:
                    # Preserve Engine's nonblocking busy refusal; never add a hidden TTS queue.
                    try:
                        wav = engine.synthesize({"text": payload["text"], "voice": selected}, timing=timing)
                        phase = "synthesis-return"
                    finally:
                        record_request(phase, request, timing)
                except RuntimeError:
                    record({"requestNs": started, "responseNs": time.monotonic_ns(),
                            "status": timing.get("status", "failed"), "timing": timing,
                            "text": payload["text"], "requestedVoice": requested,
                            "effectiveVoice": selected, "provider": "kokoro"})
                    raise
                info = inspect_wav(wav)
                record({"requestNs": started, "responseNs": time.monotonic_ns(), "text": payload["text"],
                        "requestedVoice": requested, "effectiveVoice": selected, "provider": "kokoro",
                        "status": "completed", "timing": timing, "bytes": len(wav), **info})
                if requested:
                    return self.send(200, wav, "audio/wav")
                key = uuid.uuid4().hex
                audio[key] = wav
                return self.send(200, {"audio_url": f"/audio/{key}"})
            except (BrokenPipeError, ConnectionResetError):
                # A cancelled client is not a second response, nor a reason to retry inference.
                print("voice-ci response disconnected", flush=True)
            except RuntimeError as error:
                self.send(503, {"error": str(error)})
            except Exception as error:
                self.send(500, {"error": str(error)})

        def log_message(self, *_):
            pass

    return Handler


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifacts", type=Path, required=True)
    args = parser.parse_args()
    root = args.artifacts.resolve()
    root.mkdir(parents=True, exist_ok=True)
    models = root / "models"
    models.mkdir(exist_ok=True)
    for name, expected in MODELS.items():
        source = Path(os.environ["REVERIE_VOICE_CI_KOKORO_MODEL" if name.endswith(".onnx")
                                 else "REVERIE_VOICE_CI_KOKORO_VOICES"])
        with source.open("rb") as stream:
            if hashlib.file_digest(stream, "sha256").hexdigest() != expected:
                raise ValueError(f"Pinned Kokoro checksum mismatch: {name}")
        if not (models / name).exists():
            (models / name).symlink_to(source)
    checkpoint = Path(os.environ["REVERIE_VOICE_CI_WHISPER_MODEL"])
    with checkpoint.open("rb") as stream:
        if hashlib.file_digest(stream, "sha256").hexdigest() != WHISPER_SHA256:
            raise ValueError("Pinned Whisper checkpoint checksum mismatch")
    # Import/load inside the CI service only; dependency-free validators stay lightweight.
    import torch
    import whisper
    torch.set_num_threads(2)
    torch.set_num_interop_threads(1)
    print("voice-ci whisper load start", flush=True)
    recognizer = whisper.load_model(str(checkpoint), device="cpu")
    print("voice-ci whisper load complete; Kokoro model load start", flush=True)
    engine = Engine(models)
    engine.warm()
    if engine.model is None:
        raise RuntimeError("Real Kokoro model failed to load")
    print("voice-ci Kokoro model load complete; no synthesis warmup performed", flush=True)
    fixture = json.loads(Path(__file__).with_name("fixtures.json").read_text())
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler(engine, recognizer, root, fixture))
    (root / "speech-url.txt").write_text(f"http://127.0.0.1:{server.server_port}")
    try:
        server.serve_forever()
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
