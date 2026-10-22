"""Local Kokoro speech service; installed with Nix, models kept in instance storage."""
from __future__ import annotations

import argparse
import fcntl
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
import logging
import os
from pathlib import Path
import threading
import urllib.request
import wave

RELEASE = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0"
MODELS = {
    "kokoro-v1.0.onnx": "7d5df8ecf7d4b1878015a32686053fd0eebe2bc377234608764cc0ef3636a6c5",
    "voices-v1.0.bin": "bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d",
}
LANGUAGES = {"a": "en-us", "b": "en-gb", "e": "es", "f": "fr-fr", "h": "hi", "i": "it", "p": "pt-br", "j": "ja", "z": "cmn"}
LOG = logging.getLogger("reverie.kokoro")


def checksum(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def ensure_models(directory: Path) -> None:
    """Atomic, serialized downloads; cached or downloaded content must match the pinned hash."""
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (directory / ".download.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        for name, expected in MODELS.items():
            target = directory / name
            if target.exists():
                if checksum(target) != expected:
                    raise ValueError(f"Model checksum mismatch: {name}; remove the damaged file to retry")
                continue
            temporary = directory / (name + ".part")
            try:
                LOG.info("Downloading %s", name)
                with urllib.request.urlopen(f"{RELEASE}/{name}", timeout=60) as response, temporary.open("wb") as output:
                    total = 0
                    while chunk := response.read(1024 * 1024):
                        total += len(chunk)
                        if total > 400 * 1024 * 1024:
                            raise ValueError("Model download exceeded size limit")
                        output.write(chunk)
                    output.flush()
                    os.fsync(output.fileno())
                if checksum(temporary) != expected:
                    raise ValueError(f"Downloaded model checksum mismatch: {name}")
                temporary.chmod(0o600)
                temporary.replace(target)
            finally:
                temporary.unlink(missing_ok=True)


def voice_options(ids: list[str], supported: set[str]) -> list[dict]:
    options = []
    for voice in sorted(ids):
        language = LANGUAGES.get(voice[:1])
        if language not in supported:
            continue
        options.append({"id": voice, "label": voice.partition("_")[2].replace("_", " ").title() or voice,
                        "language": language, "gender": {"f": "feminine", "m": "masculine"}.get(voice[1:2], "unspecified")})
    return options


class Engine:
    def __init__(self, directory: Path):
        self.directory = directory
        self.model = None
        self.voices: list[dict] = []
        self.error = False
        self.lock = threading.Lock()

    def warm(self) -> None:
        try:
            import onnxruntime as ort
            from kokoro_onnx import Kokoro
            from phonemizer.backend import EspeakBackend
            ensure_models(self.directory)
            options = ort.SessionOptions()
            options.intra_op_num_threads = 2
            options.inter_op_num_threads = 1
            session = ort.InferenceSession(str(self.directory / "kokoro-v1.0.onnx"), sess_options=options,
                                           providers=["CPUExecutionProvider"])
            model = Kokoro.from_session(session, str(self.directory / "voices-v1.0.bin"))
            voices = voice_options(model.get_voices(), set(EspeakBackend.supported_languages()))
            if not voices:
                raise ValueError("No compatible Kokoro voices are installed")
            self.voices = voices
            self.model = model
            LOG.info("Ready with %d voices", len(voices))
        except Exception:
            self.error = True
            LOG.exception("Kokoro could not start")

    def synthesize(self, payload: dict) -> bytes:
        import numpy as np
        if self.model is None:
            raise RuntimeError("Kokoro is unavailable" if self.error else "Kokoro is loading")
        text = payload.get("text")
        if not isinstance(text, str) or not text.strip() or len(text) > 600:
            raise ValueError("Text must contain 1 to 600 characters")
        voice = payload.get("voice")
        if voice is None:
            speaker = payload.get("speaker", "expert")
            if not isinstance(speaker, str) or len(speaker) > 200:
                raise ValueError("Invalid speaker")
            english = [v for v in self.voices if v["language"].startswith("en-")]
            voice = english[int.from_bytes(hashlib.sha256(speaker.encode()).digest()[:4], "big") % len(english)]["id"]
        selected = next((v for v in self.voices if v["id"] == voice), None)
        if selected is None:
            raise ValueError("Unknown or unsupported voice")
        # A busy model returns immediately; do not accumulate speech after clients time out.
        if not self.lock.acquire(blocking=False):
            raise RuntimeError("Kokoro is busy; try again")
        try:
            samples, rate = self.model.create(text.strip(), voice=voice, speed=1.0, lang=selected["language"])
            pcm = (np.clip(samples, -1, 1) * 32767).astype("<i2").tobytes()
            output = io.BytesIO()
            with wave.open(output, "wb") as audio:
                audio.setnchannels(1)
                audio.setsampwidth(2)
                audio.setframerate(rate)
                audio.writeframes(pcm)
            return output.getvalue()
        finally:
            self.lock.release()


def handler(engine: Engine):
    class Handler(BaseHTTPRequestHandler):
        def setup(self):
            super().setup()
            self.connection.settimeout(30)

        def send(self, status: int, data: bytes | dict, content_type="application/json"):
            body = data if isinstance(data, bytes) else json.dumps(data).encode()
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if self.path == "/health":
                ready = engine.model is not None
                self.send(200 if ready else 503, {"status": "ready" if ready else "error" if engine.error else "loading"})
            elif self.path == "/voices":
                self.send(200 if engine.model is not None else 503, {"voices": engine.voices})
            else:
                self.send(404, {"error": "Not found"})

        def do_POST(self):
            if self.path != "/tts":
                return self.send(404, {"error": "Not found"})
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= 8192:
                    return self.send(413, {"error": "Speech request is too large or empty"})
                payload = json.loads(self.rfile.read(length))
                if not isinstance(payload, dict):
                    raise ValueError("Expected a JSON object")
                self.send(200, engine.synthesize(payload), "audio/wav")
            except ValueError as error:
                self.send(400, {"error": str(error)})
            except RuntimeError as error:
                self.send(503, {"error": str(error)})
            except Exception:
                LOG.exception("Speech synthesis failed")
                self.send(500, {"error": "Speech synthesis failed"})

        def log_message(self, *_):
            pass
    return Handler


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    root = Path(os.environ.get("REVERIE_ROOT", Path.home() / "reverie"))
    data = Path(os.environ.get("REVERIE_DATA", root / "companies/default/data"))
    parser.add_argument("--models", type=Path, default=Path(os.environ.get("REVERIE_KOKORO_MODELS", data / "voice/kokoro")))
    parser.add_argument("--port", type=int, default=8091)
    args = parser.parse_args()
    os.umask(0o077)
    logging.basicConfig(level=logging.INFO)
    engine = Engine(args.models)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), handler(engine))
    threading.Thread(target=engine.warm, daemon=True).start()
    try:
        server.serve_forever()
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
