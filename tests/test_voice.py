import tests  # noqa: F401  isolates CODEMAN_*/FLEET_* before cto is imported
import json
import subprocess
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

from cto.chat import Brain, ChatDaemon
from cto.embeddings import HashedEmbedder
from cto.memory import MemoryStore
from cto.voice import (AudioStore, Synthesizer, Transcriber, VoiceConfig, VoiceService, clean_transcript, download,
                        format_hint, parse_multipart, piper_voice_url, serve, silent_wav, wav_duration_ms)
from tests.helpers import FakeRoom, fake_client, temp_config

FIXTURE = Path(__file__).parent / "fixtures" / "tone.wav"


class FakeTools:
    """Stands in for ffmpeg, whisper-cli and piper."""

    def __init__(self, transcript="hello CTO, how was your night?"):
        self.transcript = transcript
        self.calls = []

    def __call__(self, cmd, stdin, timeout):
        self.calls.append(list(cmd))
        name = Path(cmd[0]).name
        if name == "ffmpeg":
            return subprocess.CompletedProcess(cmd, 0, stdout=silent_wav(300), stderr=b"")
        if name == "whisper-cli":
            return subprocess.CompletedProcess(cmd, 0, stdout=f"\n [BLANK_AUDIO] {self.transcript} (laughs)\n".encode(), stderr=b"")
        if name == "piper":
            Path(cmd[cmd.index("--output_file") + 1]).write_bytes(silent_wav(200, 22050))
            return subprocess.CompletedProcess(cmd, 0, stdout=b"", stderr=b"")
        raise AssertionError(cmd)


def vcfg(tmp: Path) -> VoiceConfig:
    c = VoiceConfig(voice_dir=tmp / "voice", ffmpeg_bin="ffmpeg", whisper_bin="whisper-cli", piper_bin="piper", port=0)
    c.voice_dir.mkdir(parents=True)
    c.whisper_model_path.write_bytes(b"model")
    for p in c.voice_paths():
        p.write_bytes(b"voice")
    return c


class HelpersTest(unittest.TestCase):
    def test_small_helpers(self):
        self.assertEqual(clean_transcript(" [BLANK_AUDIO] hi there (music) *laughs* "), "hi there")
        self.assertEqual(piper_voice_url("en_GB-jenny_dioco-medium"),
                         "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_GB/jenny_dioco/medium/en_GB-jenny_dioco-medium.onnx")
        self.assertEqual(wav_duration_ms(FIXTURE.read_bytes()), 400)
        self.assertEqual(wav_duration_ms(b"junk"), 0)
        self.assertEqual(format_hint("clip.webm", ""), "webm")
        self.assertEqual(format_hint("", "audio/mp4"), "mp4")
        self.assertEqual(format_hint("", "audio/ogg; codecs=opus"), "ogg")
        self.assertEqual(format_hint("", "application/octet-stream"), "")

    def test_multipart(self):
        body = (b"--XX\r\nContent-Disposition: form-data; name=\"note\"\r\n\r\nhi\r\n"
                b"--XX\r\nContent-Disposition: form-data; name=\"audio\"; filename=\"a.webm\"\r\nContent-Type: audio/webm\r\n\r\nDATA\r\n--XX--\r\n")
        data, fname, ctype = parse_multipart(body, 'multipart/form-data; boundary="XX"')
        self.assertEqual((data, fname, ctype), (b"DATA", "a.webm", "audio/webm"))
        self.assertIsNone(parse_multipart(body, "multipart/form-data"))
        self.assertIsNone(parse_multipart(b"--XX\r\nContent-Disposition: form-data; name=\"x\"\r\n\r\n1\r\n--XX--", "multipart/form-data; boundary=XX"))

    def test_download_once(self):
        d = Path(tempfile.mkdtemp()) / "m.bin"
        calls = []
        download("u", d, fetch=lambda u, p: (calls.append(u), p.write_bytes(b"x")))
        download("u", d, fetch=lambda u, p: calls.append("again"))
        self.assertEqual(calls, ["u"])
        self.assertEqual(d.read_bytes(), b"x")

    def test_audio_store(self):
        a = AudioStore(Path(tempfile.mkdtemp()), ttl=10)
        aid = a.put(b"wav")
        self.assertEqual(a.get(aid), b"wav")
        self.assertIsNone(a.get("../etc/passwd"))
        self.assertIsNone(a.get("0" * 16))
        self.assertEqual(a.sweep(now=1e12), 1)
        self.assertIsNone(a.get(aid))


class EnginesTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.cfg = vcfg(self.tmp)
        self.tools = FakeTools()

    def test_transcriber(self):
        t = Transcriber(self.cfg, runner=self.tools)
        self.assertEqual(t.transcribe(FIXTURE.read_bytes(), "wav"), "hello CTO, how was your night?")
        ff, wh = self.tools.calls
        self.assertEqual(ff[:1] + ff[-3:], ["ffmpeg", "-f", "wav", "pipe:1"])
        self.assertIn("-t", wh)
        self.assertEqual(wh[wh.index("-t") + 1], "4")
        self.assertIn("-ng", wh)                     # CPU by default
        t.warm()
        self.assertTrue(t.ready)

    def test_transcriber_errors(self):
        def failing(cmd, stdin, timeout):
            return subprocess.CompletedProcess(cmd, 1, stdout=b"", stderr=b"bad input")
        with self.assertRaises(ValueError):
            Transcriber(self.cfg, runner=failing).transcribe(b"garbage")

    def test_installed_voices(self):
        s = Synthesizer(self.cfg, runner=self.tools)
        (self.cfg.voice_dir / "en_GB-alba-medium.onnx").write_bytes(b"v")
        (self.cfg.voice_dir / "en_GB-alba-medium.onnx.json").write_text(json.dumps({"language": {"code": "en_GB"}, "audio": {"sample_rate": 22050, "quality": "medium"}}))
        voices = s.installed()
        self.assertEqual([v["name"] for v in voices], ["en_US-amy-medium", "en_GB-alba-medium"])
        self.assertTrue(voices[0]["default"])
        self.assertEqual(voices[1]["language"], "en_GB")
        self.assertEqual(voices[1]["sample_rate"], 22050)

    def test_synthesizer(self):
        s = Synthesizer(self.cfg, runner=self.tools)
        wav = s.synthesize("Hello User.")
        self.assertEqual(wav_duration_ms(wav), 200)
        self.assertEqual(self.tools.calls[0][:1], ["piper"])
        with self.assertRaises(ValueError):
            s.synthesize("   ")


def make_service(tmp, transcript="hello CTO, how was your night?", reply="Restful, thank you for asking."):
    cfg = temp_config()
    store = MemoryStore(cfg.db_path, HashedEmbedder(64))
    client, transport = fake_client(reply)
    room = FakeRoom(cfg.session_id, cfg.hold_path)
    brain = Brain(cfg, store, client, room)
    tools = FakeTools(transcript)
    v = vcfg(tmp)
    svc = VoiceService(v, brain, Transcriber(v, runner=tools), Synthesizer(v, runner=tools), AudioStore(tmp / "audio"))
    return svc, brain, room, transport


class ServiceTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())

    def test_turn_runs_pipeline_without_posting(self):
        svc, brain, room, transport = make_service(self.tmp)
        out = svc.turn(FIXTURE.read_bytes(), "wav")
        self.assertEqual(out["transcript"], "hello CTO, how was your night?")
        self.assertEqual(out["reply"], "Restful, thank you for asking.")
        self.assertTrue(out["audio_url"].startswith("/audio/") and out["audio_url"].endswith(".wav"))
        self.assertEqual(set(out["timings"]), {"stt_ms", "llm_ms", "tts_ms", "total_ms"})
        self.assertEqual(room.said, [])                                         # the dashboard posts, not us
        self.assertEqual(brain.store.recent_episodes(1)[0].user_text, "hello CTO, how was your night?")
        self.assertIsNotNone(svc.audio.get(out["id"]))
        self.assertTrue(brain.store.is_voice_claimed("🎙 Hello CTO, how was your night?"))
        self.assertEqual(transport.calls[0]["messages"][-1]["content"], "hello CTO, how was your night?")

    def test_long_reply_is_not_trimmed_and_audio_published_whole(self):
        long = " ".join(f"Sentence number {i} of a long spoken answer, User." for i in range(1, 21))   # 180 words
        svc, brain, room, transport = make_service(self.tmp, reply=long)
        out = svc.turn(FIXTURE.read_bytes(), "wav")
        self.assertEqual(out["reply"], long)
        self.assertEqual(transport.calls[0]["max_tokens"], brain.cfg.voice_reply_max_tokens)
        self.assertEqual(brain.store.recent_episodes(1)[0].assistant_text, long)
        self.assertFalse(list(svc.audio.dir.glob(".*.part")))
        self.assertEqual(wav_duration_ms(svc.audio.get(out["id"])), 200)
        # typed replies keep a generous safety cap only

    def test_text_turn(self):
        svc, brain, room, transport = make_service(self.tmp, reply="I slept well, thank you.")
        out = svc.text_turn("  how was your night?  ")
        self.assertEqual(out["transcript"], "how was your night?")
        self.assertEqual(out["reply"], "I slept well, thank you.")
        self.assertEqual(set(out["timings"]), {"llm_ms", "total_ms"})
        self.assertNotIn("audio_url", out)
        self.assertEqual(room.said, [])
        self.assertTrue(brain.store.is_voice_claimed("How was your night?"))
        with self.assertRaises(ValueError):
            svc.text_turn(" ")
        svc2, *_ = make_service(self.tmp / "b", reply=None)
        self.assertIsNone(svc2.text_turn("hello")["reply"])

    def test_turn_nothing_heard_and_no_reply(self):
        svc, *_ = make_service(self.tmp, transcript="")
        self.assertIsNone(svc.turn(FIXTURE.read_bytes(), "wav"))
        svc2, *_ = make_service(self.tmp / "b", reply=None)
        out = svc2.turn(FIXTURE.read_bytes(), "wav")
        self.assertIsNone(out["reply"])
        self.assertEqual(out["error"], "no reply")

    def test_daemon_skips_voice_messages(self):
        cfg = temp_config()
        store = MemoryStore(cfg.db_path, HashedEmbedder(64))
        client, _ = fake_client("Hey.")
        room = FakeRoom(cfg.session_id, cfg.hold_path)
        d = ChatDaemon(cfg, Brain(cfg, store, client, room))
        room.inbox.append({"id": "v1", "from": {"kind": "user"}, "to": ["me"], "text": "spoken thing", "voice": True})
        store.claim_voice("another spoken thing")
        room.post("🎙 Another spoken thing")
        room.post("typed thing")
        room.inbox.append({"id": "s1", "from": {"kind": "user"}, "to": ["me"], "text": "hands-free car mode thing", "spoken": True})
        self.assertEqual(d.tick(), 2)                                 # typed and spoken:true answered, voice:true skipped
        self.assertEqual(room.said, ["Hey.", "Hey."])
        self.assertEqual([m.user_text for m in store.recent_episodes(2)], ["typed thing", "hands-free car mode thing"])


class HttpTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.svc, self.brain, self.room, _ = make_service(self.tmp)
        self.svc.cfg.host = "127.0.0.1"
        self.httpd = serve(self.svc)
        self.base = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()

    def req(self, method, path, body=None, headers=None):
        r = urllib.request.Request(self.base + path, data=body, method=method, headers=headers or {})
        try:
            with urllib.request.urlopen(r, timeout=10) as resp:
                return resp.status, resp.headers, resp.read()
        except urllib.error.HTTPError as e:
            return e.code, e.headers, e.read()

    def test_health_and_cors(self):
        code, headers, body = self.req("GET", "/health")
        self.assertEqual(code, 200)
        self.assertEqual(json.loads(body)["status"], "ok")
        self.assertEqual(headers["Access-Control-Allow-Origin"], "*")
        self.assertEqual(self.req("OPTIONS", "/turn")[0], 204)
        code, _, body = self.req("GET", "/voices")
        self.assertEqual(code, 200)
        self.assertEqual(json.loads(body)["voices"][0]["name"], "en_US-amy-medium")
        self.assertEqual(self.req("GET", "/nope")[0], 404)

    def test_stt_tts_turn_audio(self):
        wav = FIXTURE.read_bytes()
        code, _, body = self.req("POST", "/stt", wav, {"Content-Type": "audio/wav"})
        self.assertEqual(code, 200)
        self.assertEqual(json.loads(body)["transcript"], "hello CTO, how was your night?")
        self.assertEqual(json.loads(body)["duration_ms"], 400)
        code, _, body = self.req("POST", "/tts", json.dumps({"text": "Hi User."}).encode(), {"Content-Type": "application/json"})
        self.assertEqual(code, 200)
        aid = json.loads(body)["id"]
        code, headers, audio = self.req("GET", f"/audio/{aid}.wav")
        self.assertEqual((code, headers["Content-Type"]), (200, "audio/wav"))
        self.assertEqual(wav_duration_ms(audio), 200)
        code, headers, raw = self.req("POST", "/tts?raw=1", json.dumps({"text": "Hi"}).encode(), {"Content-Type": "application/json"})
        self.assertEqual((code, headers["Content-Type"]), (200, "audio/wav"))
        code, _, body = self.req("POST", "/turn", wav, {"Content-Type": "audio/mp4", "X-Codeman-Room": "room-1"})
        self.assertEqual(code, 200)
        out = json.loads(body)
        self.assertEqual(out["reply"], "Restful, thank you for asking.")
        self.assertEqual(self.req("GET", out["audio_url"])[0], 200)
        self.assertEqual(self.room.said, [])
        code, _, body = self.req("POST", "/turn", json.dumps({"text": "typed hello"}).encode(), {"Content-Type": "application/json"})
        self.assertEqual(code, 200)
        self.assertEqual(json.loads(body)["reply"], "Restful, thank you for asking.")
        self.assertNotIn("audio_url", json.loads(body))
        self.assertEqual(self.req("POST", "/turn", b"{}", {"Content-Type": "application/json"})[0], 400)
        for bad in (b"[]", b'"x"', b"7", b"{not json"):
            self.assertEqual(self.req("POST", "/turn", bad, {"Content-Type": "application/json"})[0], 400, bad)
            self.assertEqual(self.req("POST", "/tts", bad, {"Content-Type": "application/json"})[0], 400, bad)
        mp = (b"--B\r\nContent-Disposition: form-data; name=\"audio\"; filename=\"a.wav\"\r\nContent-Type: audio/wav\r\n\r\n" + wav + b"\r\n--B--\r\n")
        self.assertEqual(self.req("POST", "/turn", mp, {"Content-Type": "multipart/form-data; boundary=B"})[0], 200)

    def test_errors(self):
        self.assertEqual(self.req("POST", "/turn", b"x", {"Content-Type": "text/plain"})[0], 400)
        self.assertEqual(self.req("POST", "/tts", b"{}", {"Content-Type": "application/json"})[0], 400)
        self.assertEqual(self.req("GET", "/audio/nothere.wav")[0], 404)
        big = b"0" * (self.svc.cfg.max_upload + 1)
        self.assertEqual(self.req("POST", "/turn", big, {"Content-Type": "audio/wav"})[0], 413)
        self.svc.stt.transcript = ""
        self.svc.stt._run.transcript = ""
        self.assertEqual(self.req("POST", "/turn", FIXTURE.read_bytes(), {"Content-Type": "audio/wav"})[0], 204)


if __name__ == "__main__":
    unittest.main()
