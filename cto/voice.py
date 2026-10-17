"""Two-way voice: ``python3 -m cto.voice`` serves a small HTTP API on 127.0.0.1:8090.

* ``POST /stt``   audio upload (webm/ogg/wav, anything ffmpeg reads) -> ``{"transcript", "duration_ms", "stt_ms"}``
* ``POST /tts``   ``{"text", "voice"?}`` -> ``{"id", "audio_url", "tts_ms"}`` (``?raw=1`` returns audio/wav)
* ``POST /turn``  audio upload -> transcribe, run CTO's normal reply pipeline in-process (memory, mood,
  beliefs, floors, persona), synthesize her reply ->
  ``{"id", "transcript", "reply", "audio_url", "timings"}``; 204 when nothing was heard.
  With a JSON body ``{"text"}`` it is a text-only turn: same pipeline, no transcription and no
  synthesis, ``{"transcript", "reply", "timings"}`` (for the phone's own speech synthesis)
* ``GET /voices`` installed piper voices (any rhasspy/piper-voices name is accepted by ``/tts`` and
  downloaded on first use), ``GET /audio/<id>.wav``, ``GET /health``

Speech to text is whisper.cpp (``whisper-cli``, model ggml-base.en by default, 4 CPU threads;
``FLEET_WHISPER_GPU=1`` takes the ``chat`` GPU lock around each call). Text to speech is
piper (voice en_US-amy-medium by default). Models are downloaded once into
``~/.local/share/cto/voice`` and warmed at start.

The service does not post to the room: the Reverie dashboard posts the transcript (as the
user) and the reply itself, both tagged ``voice: true``, which the chat daemon skips. As a
fallback the transcript is also recorded in the shared memory store so the daemon skips a
matching user message even without the tag.
"""
from __future__ import annotations

import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
import uuid
import wave
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Callable, Sequence
from urllib.parse import urlparse, parse_qs

from .config import Config, DATA_DIR
from .gpu import GpuLock
from .log import get

Runner = Callable[[Sequence[str], bytes | None, int], subprocess.CompletedProcess]


def _run(cmd: Sequence[str], stdin: bytes | None, timeout: int) -> subprocess.CompletedProcess:
    return subprocess.run(list(cmd), input=stdin, capture_output=True, timeout=timeout)


WHISPER_URL = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-{model}.bin"
PIPER_URL = "https://huggingface.co/rhasspy/piper-voices/resolve/main/{lang}/{lang_region}/{name}/{quality}/{voice}.onnx"
_NOISE = re.compile(r"\[[^\]]*\]|\([^)]*\)|\*[^*]*\*")   # [BLANK_AUDIO], (music), *laughs*


@dataclass
class VoiceConfig:
    host: str = os.environ.get("FLEET_VOICE_HOST", "127.0.0.1")
    port: int = int(os.environ.get("FLEET_VOICE_PORT", "8090"))
    voice_dir: Path = Path(os.environ.get("FLEET_VOICE_DIR", DATA_DIR / "voice"))
    ffmpeg_bin: str = os.environ.get("FLEET_FFMPEG_BIN", shutil.which("ffmpeg") or "ffmpeg")
    whisper_bin: str = os.environ.get("FLEET_WHISPER_BIN", shutil.which("whisper-cli") or "whisper-cli")
    whisper_model: str = os.environ.get("FLEET_WHISPER_MODEL", "base.en")      # base.en or small.en
    whisper_threads: int = int(os.environ.get("FLEET_WHISPER_THREADS", "4"))
    whisper_gpu: bool = os.environ.get("FLEET_WHISPER_GPU", "0") == "1"
    piper_bin: str = os.environ.get("FLEET_PIPER_BIN", shutil.which("piper") or "piper")
    voice: str = os.environ.get("FLEET_VOICE", "en_US-amy-medium")               # or en_GB-jenny_dioco-medium
    audio_ttl: int = int(os.environ.get("FLEET_AUDIO_TTL", "3600"))
    max_upload: int = 10 * 1024 * 1024
    timeout: int = 120
    room_post: bool = True

    @property
    def audio_dir(self) -> Path:
        return self.voice_dir / "audio"

    @property
    def whisper_model_path(self) -> Path:
        return self.voice_dir / f"ggml-{self.whisper_model}.bin"

    def voice_paths(self, voice: str | None = None) -> tuple[Path, Path]:
        v = voice or self.voice
        return self.voice_dir / f"{v}.onnx", self.voice_dir / f"{v}.onnx.json"


def piper_voice_url(voice: str) -> str:
    """en_US-amy-medium -> .../en/en_US/amy/medium/en_US-amy-medium.onnx"""
    lang_region, name, quality = voice.split("-", 2)
    return PIPER_URL.format(lang=lang_region.split("_")[0], lang_region=lang_region, name=name, quality=quality, voice=voice)


def download(url: str, dest: Path, fetch: Callable[[str, Path], None] | None = None) -> Path:
    if dest.exists() and dest.stat().st_size > 0:
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    if fetch:
        fetch(url, tmp)
    else:
        with urllib.request.urlopen(url, timeout=600) as r, tmp.open("wb") as f:
            shutil.copyfileobj(r, f)
    tmp.replace(dest)
    return dest


def wav_duration_ms(data: bytes) -> int:
    try:
        with wave.open(io.BytesIO(data)) as w:
            return int(1000 * w.getnframes() / (w.getframerate() or 1))
    except (wave.Error, EOFError):
        return 0


def silent_wav(ms: int = 1000, rate: int = 16000) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(b"\0\0" * int(rate * ms / 1000))
    return buf.getvalue()


def clean_transcript(text: str) -> str:
    return " ".join(_NOISE.sub(" ", text or "").split())


class Transcriber:
    def __init__(self, cfg: VoiceConfig, runner: Runner = _run, lock: GpuLock | None = None):
        self.cfg = cfg
        self._run = runner
        self.lock = lock
        self.ready = False

    def ensure_model(self, fetch=None) -> Path:
        return download(WHISPER_URL.format(model=self.cfg.whisper_model), self.cfg.whisper_model_path, fetch)

    def to_wav16k(self, audio: bytes, hint: str = "") -> bytes:
        """Any container/codec -> 16 kHz mono 16-bit wav, via ffmpeg."""
        cmd = [self.cfg.ffmpeg_bin, "-hide_banner", "-loglevel", "error", "-nostdin"]
        if hint:
            cmd += ["-f", hint]
        cmd += ["-i", "pipe:0", "-ac", "1", "-ar", "16000", "-sample_fmt", "s16", "-f", "wav", "pipe:1"]
        p = self._run(cmd, audio, self.cfg.timeout)
        if p.returncode != 0 or not p.stdout:
            raise ValueError("ffmpeg could not decode the audio: " + (p.stderr or b"").decode(errors="replace")[-300:])
        return p.stdout

    def transcribe(self, audio: bytes, hint: str = "") -> str:
        wav = self.to_wav16k(audio, hint)
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
            f.write(wav)
            path = f.name
        try:
            cmd = [self.cfg.whisper_bin, "-m", str(self.cfg.whisper_model_path), "-f", path, "-t", str(self.cfg.whisper_threads),
                   "-nt", "-np", "-l", "en"]
            if not self.cfg.whisper_gpu:
                cmd.append("-ng")
            got = bool(self.cfg.whisper_gpu and self.lock and self.lock.acquire(timeout=30))
            try:
                p = self._run(cmd, None, self.cfg.timeout)
            finally:
                if got:
                    self.lock.release()
        finally:
            try:
                os.unlink(path)
            except OSError:
                pass
        if p.returncode != 0:
            raise RuntimeError("whisper failed: " + (p.stderr or b"").decode(errors="replace")[-300:])
        return clean_transcript(p.stdout.decode(errors="replace"))

    def warm(self) -> None:
        self.ensure_model()
        self.transcribe(silent_wav(500), "wav")
        self.ready = True


class Synthesizer:
    def __init__(self, cfg: VoiceConfig, runner: Runner = _run):
        self.cfg = cfg
        self._run = runner
        self.ready = False

    def ensure_voice(self, voice: str | None = None, fetch=None) -> tuple[Path, Path]:
        onnx, meta = self.cfg.voice_paths(voice)
        url = piper_voice_url(voice or self.cfg.voice)
        download(url, onnx, fetch)
        download(url + ".json", meta, fetch)
        return onnx, meta

    def synthesize(self, text: str, voice: str | None = None) -> bytes:
        text = " ".join((text or "").split())
        if not text:
            raise ValueError("nothing to say")
        onnx, _ = self.ensure_voice(voice)
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
            out = f.name
        try:
            p = self._run([self.cfg.piper_bin, "--model", str(onnx), "--output_file", out], text.encode() + b"\n", self.cfg.timeout)
            if p.returncode != 0:
                raise RuntimeError("piper failed: " + (p.stderr or b"").decode(errors="replace")[-300:])
            return Path(out).read_bytes()
        finally:
            try:
                os.unlink(out)
            except OSError:
                pass

    def installed(self) -> list[dict]:
        """Voices present on disk, default first, with model size and language from the piper metadata."""
        out = []
        for onnx in sorted(self.cfg.voice_dir.glob("*.onnx")):
            name = onnx.name[:-5]
            meta = {}
            try:
                meta = json.loads((self.cfg.voice_dir / f"{name}.onnx.json").read_text(encoding="utf-8"))
            except (OSError, ValueError):
                pass
            lang = (meta.get("language") or {}).get("code", "")
            out.append({"name": name, "default": name == self.cfg.voice, "language": lang, "quality": meta.get("audio", {}).get("quality") or name.rsplit("-", 1)[-1],
                        "sample_rate": (meta.get("audio") or {}).get("sample_rate"), "size_mb": round(onnx.stat().st_size / 2**20, 1)})
        out.sort(key=lambda v: (not v["default"], v["name"]))
        return out

    def warm(self) -> None:
        self.ensure_voice()
        self.synthesize("Hello.")
        self.ready = True


class AudioStore:
    """Synthesised wavs served from /audio/<id>.wav for ``ttl`` seconds."""

    def __init__(self, directory: Path, ttl: int = 3600):
        self.dir = directory
        self.ttl = ttl
        self.dir.mkdir(parents=True, exist_ok=True)

    def put(self, data: bytes) -> str:
        """Publish a complete wav: written to a temp name, fsynced, then renamed into place, so a
        reader never sees a partial file under the final name."""
        self.sweep()
        aid = uuid.uuid4().hex[:16]
        final = self.dir / f"{aid}.wav"
        tmp = self.dir / f".{aid}.part"
        with tmp.open("wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        tmp.replace(final)
        return aid

    def get(self, aid: str) -> bytes | None:
        if not re.fullmatch(r"[0-9a-f]{16}", aid or ""):
            return None
        p = self.dir / f"{aid}.wav"
        return p.read_bytes() if p.exists() else None

    def sweep(self, now: float | None = None) -> int:
        now = time.time() if now is None else now
        n = 0
        for p in self.dir.glob("*.wav"):
            try:
                if now - p.stat().st_mtime > self.ttl:
                    p.unlink()
                    n += 1
            except OSError:
                pass
        return n


class VoiceService:
    def __init__(self, cfg: VoiceConfig, brain, transcriber: Transcriber, synthesizer: Synthesizer, audio: AudioStore | None = None):
        self.cfg = cfg
        self.brain = brain                   # cto.chat.Brain: reply() runs the whole pipeline and posts to the room
        self.stt = transcriber
        self.tts = synthesizer
        self.audio = audio or AudioStore(cfg.audio_dir, cfg.audio_ttl)
        self.log = get("cto.voice")
        self._turn_lock = threading.Lock()

    def warm(self) -> None:
        for name, engine in (("stt", self.stt), ("tts", self.tts)):
            t0 = time.time()
            try:
                engine.warm()
                self.log.info("%s warm in %.1fs", name, time.time() - t0)
            except Exception as e:
                self.log.error("%s warm-up failed: %r", name, e)

    def health(self) -> dict:
        return {"status": "ok", "stt": "ready" if self.stt.ready else "loading", "tts": "ready" if self.tts.ready else "loading",
                "whisper_model": self.cfg.whisper_model, "voice": self.cfg.voice, "chat_model": self.brain.cfg.model}

    def transcribe(self, audio: bytes, hint: str = "") -> dict:
        t0 = time.time()
        text = self.stt.transcribe(audio, hint)
        return {"transcript": text, "duration_ms": wav_duration_ms(audio) if hint == "wav" else 0,
                "stt_ms": int(1000 * (time.time() - t0))}

    def speak(self, text: str, voice: str | None = None) -> tuple[str, bytes, int]:
        t0 = time.time()
        wav = self.tts.synthesize(text, voice)
        return self.audio.put(wav), wav, int(1000 * (time.time() - t0))

    def respond(self, transcript: str) -> tuple[str | None, int]:
        """CTO's reply to one spoken or typed-for-voice utterance, never trimmed, not posted to the room."""
        with self._turn_lock:
            self.brain.store.claim_voice(transcript)
            t1 = time.time()
            from .opencode import voice_reply
            try:
                delegated, reply = voice_reply(self.brain, transcript)
            except Exception as error:
                self.log.error("OpenCode voice runtime unavailable: %r", error)
                return None, int(1000 * (time.time() - t1))
            if delegated:
                return reply, int(1000 * (time.time() - t1))
            reply = self.brain.reply(transcript, post=False, max_tokens=self.brain.cfg.voice_reply_max_tokens,
                                     max_words=self.brain.cfg.voice_reply_max_words)
            return reply, int(1000 * (time.time() - t1))

    def turn(self, audio: bytes, hint: str = "") -> dict | None:
        """The whole exchange; None when nothing intelligible was heard."""
        t0 = time.time()
        stt = self.transcribe(audio, hint)
        transcript = stt["transcript"]
        if len(transcript) < 2:
            self.log.info("turn: nothing heard (%d ms stt)", stt["stt_ms"])
            return None
        reply, llm_ms = self.respond(transcript)
        if not reply:
            self.log.warning("turn: heard %r but no reply (%d ms llm)", transcript, llm_ms)
            return {"transcript": transcript, "reply": None, "error": "no reply", "timings": {"stt_ms": stt["stt_ms"], "llm_ms": llm_ms}}
        aid, _, tts_ms = self.speak(reply)
        self.log.info("turn: heard %r -> %r (%d ms)", transcript, reply, int(1000 * (time.time() - t0)))
        return {"id": aid, "transcript": transcript, "reply": reply, "audio_url": f"/audio/{aid}.wav",
                "timings": {"stt_ms": stt["stt_ms"], "llm_ms": llm_ms, "tts_ms": tts_ms, "total_ms": int(1000 * (time.time() - t0))}}

    def text_turn(self, text: str) -> dict:
        """A typed (or phone-transcribed) turn with no audio: the phone speaks the reply itself."""
        t0 = time.time()
        text = " ".join((text or "").split())
        if len(text) < 2:
            raise ValueError("text is empty")
        reply, llm_ms = self.respond(text)
        if not reply:
            self.log.warning("text turn: %r but no reply (%d ms llm)", text, llm_ms)
            return {"transcript": text, "reply": None, "error": "no reply", "timings": {"llm_ms": llm_ms}}
        self.log.info("text turn: %r -> %r (%d ms)", text, reply, llm_ms)
        return {"transcript": text, "reply": reply, "timings": {"llm_ms": llm_ms, "total_ms": int(1000 * (time.time() - t0))}}


# ---- HTTP -----------------------------------------------------------------
def parse_multipart(body: bytes, content_type: str, field: str = "audio") -> tuple[bytes, str, str] | None:
    """Return (data, filename, part content-type) of the named part, or None."""
    m = re.search(r'boundary="?([^";]+)"?', content_type or "")
    if not m:
        return None
    boundary = b"--" + m.group(1).encode()
    for part in body.split(boundary)[1:]:
        if part.strip() in (b"", b"--"):
            continue
        head, sep, data = part.partition(b"\r\n\r\n")
        if not sep:
            continue
        headers = head.decode(errors="replace")
        disp = re.search(r'name="([^"]*)"', headers)
        if not disp or disp.group(1) != field:
            continue
        fname = re.search(r'filename="([^"]*)"', headers)
        ctype = re.search(r"Content-Type:\s*([^\r\n]+)", headers, re.I)
        if data.endswith(b"\r\n"):
            data = data[:-2]
        return data, (fname.group(1) if fname else ""), (ctype.group(1).strip() if ctype else "")
    return None


def format_hint(filename: str, content_type: str) -> str:
    """An ffmpeg demuxer name from the upload's extension or MIME type ('' lets ffmpeg probe)."""
    ext = Path(filename or "").suffix.lower().lstrip(".")
    ct = (content_type or "").lower().split(";")[0].strip()
    table = {"webm": "webm", "ogg": "ogg", "oga": "ogg", "opus": "ogg", "wav": "wav", "mp3": "mp3", "m4a": "mp4", "mp4": "mp4", "flac": "flac"}
    if ext in table:
        return table[ext]
    for key, fmt in (("webm", "webm"), ("ogg", "ogg"), ("wav", "wav"), ("x-wav", "wav"), ("mpeg", "mp3"), ("mp4", "mp4"), ("flac", "flac")):
        if ct.endswith(key):
            return fmt
    return ""


def make_handler(service: VoiceService):
    class Handler(BaseHTTPRequestHandler):
        server_version = "fleet-voice/0.1"

        def log_message(self, fmt, *args):   # keep the console quiet; service logs the interesting bits
            pass

        def _cors(self):
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")

        def _send(self, code: int, body: bytes = b"", ctype: str = "application/json"):
            self.send_response(code)
            self._cors()
            if body:
                self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            if body:
                self.wfile.write(body)

        def _json(self, code: int, obj) -> None:
            self._send(code, json.dumps(obj).encode())

        def _body(self) -> bytes:
            n = int(self.headers.get("Content-Length") or 0)
            if n > service.cfg.max_upload:
                left = n
                while left > 0:                       # drain so the client sees the 413 instead of a broken pipe
                    left -= len(self.rfile.read(min(left, 1 << 20)) or b"\0")
                raise OverflowError(f"body over {service.cfg.max_upload} bytes")
            return self.rfile.read(n) if n else b""

        def _audio_upload(self) -> tuple[bytes, str]:
            ctype = self.headers.get("Content-Type", "")
            body = self._body()
            if ctype.startswith("multipart/form-data"):
                part = parse_multipart(body, ctype)
                if not part:
                    raise ValueError("multipart body has no 'audio' part")
                data, fname, pct = part
                return data, format_hint(fname, pct)
            if ctype.startswith("audio/") or ctype.startswith("video/webm") or ctype == "application/octet-stream":
                return body, format_hint("", ctype)
            raise ValueError("send multipart/form-data with an 'audio' part, or a raw audio/* body")

        def do_OPTIONS(self):
            self._send(204)

        def do_GET(self):
            path = urlparse(self.path).path
            if path == "/health":
                return self._json(200, service.health())
            if path == "/voices":
                return self._json(200, {"default": service.cfg.voice, "voices": service.tts.installed(),
                                        "source": "rhasspy/piper-voices; any voice name there is downloaded on first use"})
            if path.startswith("/audio/") and path.endswith(".wav"):
                data = service.audio.get(path[len("/audio/"):-4])
                if data is None:
                    return self._json(404, {"error": "no such audio"})
                return self._send(200, data, "audio/wav")
            self._json(404, {"error": "not found"})

        def do_POST(self):
            url = urlparse(self.path)
            try:
                if url.path == "/stt":
                    data, hint = self._audio_upload()
                    return self._json(200, service.transcribe(data, hint))
                if url.path == "/tts":
                    req = json.loads(self._body() or b"{}")
                    if not isinstance(req, dict):
                        raise ValueError("JSON body must be an object with a text field")
                    aid, wav, ms = service.speak(str(req.get("text", "")), req.get("voice") or None)
                    if parse_qs(url.query).get("raw", ["0"])[0] == "1":
                        return self._send(200, wav, "audio/wav")
                    return self._json(200, {"id": aid, "audio_url": f"/audio/{aid}.wav", "tts_ms": ms})
                if url.path == "/turn":
                    room = self.headers.get("X-Codeman-Room", "")
                    if room:
                        service.log.info("turn for room %s", room)
                    if self.headers.get("Content-Type", "").startswith("application/json"):
                        req = json.loads(self._body() or b"{}")
                        if not isinstance(req, dict):
                            raise ValueError("JSON body must be an object with a text field")
                        result = service.text_turn(str(req.get("text", "")))
                        return self._json(503 if result.get("reply") is None else 200, result)
                    data, hint = self._audio_upload()
                    result = service.turn(data, hint)
                    if result is None:
                        return self._send(204)
                    if result.get("reply") is None:
                        return self._json(503, result)
                    return self._json(200, result)
                return self._json(404, {"error": "not found"})
            except ValueError as e:
                return self._json(400, {"error": str(e)})
            except OverflowError as e:
                return self._json(413, {"error": str(e)})
            except Exception as e:
                service.log.error("request failed: %r", e)
                return self._json(500, {"error": repr(e)})

    return Handler


def serve(service: VoiceService) -> ThreadingHTTPServer:
    httpd = ThreadingHTTPServer((service.cfg.host, service.cfg.port), make_handler(service))
    httpd.daemon_threads = True
    return httpd


def main(argv: Sequence[str] | None = None) -> int:
    import argparse

    from .chat import ChatDaemon

    p = argparse.ArgumentParser(prog="python3 -m cto.voice", description="CTO voice service: /stt, /tts, /turn, /audio, /health")
    p.add_argument("--host")
    p.add_argument("--port", type=int)
    p.add_argument("--no-warm", action="store_true", help="skip model warm-up at start")
    args = p.parse_args(argv)
    vcfg = VoiceConfig()
    if args.host:
        vcfg.host = args.host
    if args.port:
        vcfg.port = args.port
    daemon = ChatDaemon(Config())                     # bootstraps store, beliefs, migration, room, brain; does not poll
    brain = daemon.brain
    lock = GpuLock("chat", daemon.cfg.gpu_lock_path, daemon.cfg.gpu_yield_path, daemon.cfg.gpu_activity_path)
    service = VoiceService(vcfg, brain, Transcriber(vcfg, lock=lock), Synthesizer(vcfg))
    if not args.no_warm:
        service.warm()
    httpd = serve(service)
    service.log.info("voice service on http://%s:%d (whisper %s, voice %s)", vcfg.host, vcfg.port, vcfg.whisper_model, vcfg.voice)
    threading.Thread(target=lambda: [l for l in sys.stdin], daemon=True).start()   # discard anything typed into the pane
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
