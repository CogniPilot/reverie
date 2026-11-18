"""Reference Kokoro synthesis for the instrumented voice CI adapter."""
from __future__ import annotations

import fcntl
import hashlib
import io
import json
import logging
import os
from pathlib import Path
import threading
import time
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

    def synthesize(self, payload: dict, *, timing: dict | None = None) -> bytes:
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
        timing = timing if timing is not None else {}
        timing["lockAttemptNs"] = time.monotonic_ns()
        if not self.lock.acquire(blocking=False):
            timing.update(status="busy", finishedNs=time.monotonic_ns())
            raise RuntimeError("Kokoro is busy; try again")
        timing.update(status="failed", acquiredNs=time.monotonic_ns())
        try:
            timing["inferenceStartNs"] = time.monotonic_ns()
            samples, rate = self.model.create(text.strip(), voice=voice, speed=1.0, lang=selected["language"])
            timing["inferenceEndNs"] = time.monotonic_ns()
            pcm = (np.clip(samples, -1, 1) * 32767).astype("<i2").tobytes()
            output = io.BytesIO()
            with wave.open(output, "wb") as audio:
                audio.setnchannels(1)
                audio.setsampwidth(2)
                audio.setframerate(rate)
                audio.writeframes(pcm)
            timing["status"] = "completed"
            return output.getvalue()
        finally:
            timing["finishedNs"] = time.monotonic_ns()
            self.lock.release()
