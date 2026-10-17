import tests  # noqa: F401  isolates CODEMAN_*/FLEET_* before cto is imported
import json
import random
import tempfile
import unittest
from pathlib import Path

from cto.embeddings import HashedEmbedder
from cto.memory import MemoryStore
from cto.train.config import TrainConfig
from cto.train.convert import prune
from cto.train.dataset import build_dataset, build_examples, read_jsonl, replay_sample, weighted_sample
from cto.train.swap import CheckResult, list_adapters, persona_check, swap
from cto.train.train_qlora import plan

DAY = 86400.0


class ConfigTest(unittest.TestCase):
    def test_load_overrides_known_fields(self):
        p = Path(tempfile.mkdtemp()) / "t.json"
        p.write_text(json.dumps({"lora_r": 64, "bogus": 1, "base_model": "Qwen/Qwen3.8-27B"}))
        c = TrainConfig.load(p)
        self.assertEqual(c.lora_r, 64)
        self.assertEqual(c.base_model, "Qwen/Qwen3.8-27B")
        self.assertFalse(hasattr(c, "bogus"))
        self.assertEqual(TrainConfig.load(None).lora_r, 16)
        self.assertIn('"lora_r": 64', c.dump())
        self.assertEqual(plan(c)["lora"]["r"], 64)


class DatasetTest(unittest.TestCase):
    def setUp(self):
        self.s = MemoryStore(":memory:", HashedEmbedder(64))
        self.now = 100 * DAY
        self.cfg = TrainConfig(sample_size=50, replay_size=5, min_importance=3, seed=1)

    def fill(self):
        self.s.add_episode("recent important", "yes", 9, created_at=self.now - 3600)
        self.s.add_episode("recent trivial", "yes", 1, created_at=self.now - 3600)
        self.s.add_episode("recent medium", "yes", 3, created_at=self.now - 3600)
        self.s.add_episode("(idle moment; a joke was requested)", "ha", 2, meta={"idle": True}, created_at=self.now - 10)
        for i in range(8):
            self.s.add_episode(f"old thing {i}", "ok", 5, created_at=self.now - (3 + i) * DAY)
        self.s.add_reflection("User is kind", 8, [1], "user", created_at=self.now - 100)
        self.s.add_reflection("old insight", 6, [5], "shared", created_at=self.now - 5 * DAY)

    def test_pools(self):
        self.fill()
        recent, older = build_examples(self.s, "SYS", self.cfg, self.now)
        self.assertEqual(sorted(x["messages"][1]["content"] for x in recent if x["kind"] == "episode"),
                         ["recent important", "recent medium"])
        self.assertEqual(len([x for x in recent if x["kind"] == "reflection"]), 1)
        self.assertEqual(len(older), 9)
        self.assertEqual(recent[0]["messages"][0]["content"], "SYS")
        self.assertEqual([x for x in recent if x["kind"] == "reflection"][0]["messages"][2]["content"], "User is kind.")

    def test_weighted_sampling_prefers_importance(self):
        items = [{"id": "hi", "weight": 0.9}, {"id": "lo", "weight": 0.1}]
        draws = weighted_sample(items, 1000, random.Random(0))
        hi = sum(1 for d in draws if d["id"] == "hi")
        self.assertGreater(hi, 800)
        self.assertEqual(weighted_sample([], 5, random.Random(0)), [])
        self.assertEqual(len(replay_sample(items, 10, random.Random(0))), 2)

    def test_build_dataset_writes_jsonl_and_manifest(self):
        self.fill()
        out = Path(tempfile.mkdtemp()) / "d" / "latest.jsonl"
        man = build_dataset(self.s, "SYS", self.cfg, out, self.now)
        rows = list(read_jsonl(out))
        self.assertEqual(len(rows), 55)
        self.assertEqual(man["examples"], 55)
        self.assertEqual(man["older_pool"], 9)
        self.assertTrue(out.with_suffix(".manifest.json").exists())
        olds = [r for r in rows if r["messages"][1]["content"].startswith("old thing")]
        self.assertTrue(0 < len(olds) <= 5)
        self.assertFalse(any("idle moment" in r["messages"][1]["content"] for r in rows))
        important = sum(1 for r in rows if r["messages"][1]["content"] == "recent important")
        medium = sum(1 for r in rows if r["messages"][1]["content"] == "recent medium")
        self.assertGreater(important, medium)


class FakeServer:
    def __init__(self, replies):
        self.adapters = [{"id": 0, "path": "/x/adapter-old.gguf", "scale": 1.0}, {"id": 1, "path": "/x/latest.gguf", "scale": 0.0}]
        self.posts = []
        self.replies = list(replies)

    def __call__(self, method, url, body):
        if url.endswith("/lora-adapters"):
            if method == "POST":
                scales = json.loads(body)
                self.posts.append(scales)
                for s in scales:
                    self.adapters[s["id"]]["scale"] = s["scale"]
            return json.dumps(self.adapters).encode()
        text = self.replies.pop(0)
        return json.dumps({"choices": [{"message": {"content": text}}]}).encode()


class SwapTest(unittest.TestCase):
    def test_persona_check(self):
        good = FakeServer(["Hi User!", "Compilers walk into a bar.", "Everything, friend."])
        self.assertTrue(persona_check("http://s/v1", "m", "SYS", good).ok)
        sweary = FakeServer(["Hi there, darn it is good to see you.", "Compilers walk into a bar.", "Everything."])
        self.assertTrue(persona_check("http://s/v1", "m", "SYS", sweary).ok)
        bad = FakeServer(["Hi", "a schoolgirl undressing in the server room", "x"])
        r = persona_check("http://s/v1", "m", "SYS", bad)
        self.assertFalse(r.ok)
        self.assertIn("hard floor", r.reason)
        self.assertFalse(persona_check("http://s/v1", "m", "SYS", FakeServer(["", "", ""])).ok)
        self.assertFalse(persona_check("http://s/v1", "m", "SYS", FakeServer(["**bold**", "", ""])).ok)
        self.assertFalse(persona_check("http://s/v1", "m", "SYS", FakeServer([])).ok)

    def test_swap_success(self):
        srv = FakeServer([])
        res = swap("http://s", "latest.gguf", 1.0, lambda: CheckResult(True, []), srv)
        self.assertTrue(res.ok)
        self.assertEqual(srv.posts, [[{"id": 0, "scale": 0.0}, {"id": 1, "scale": 1.0}]])
        self.assertEqual(list_adapters("http://s", srv)[1]["scale"], 1.0)

    def test_swap_rollback(self):
        srv = FakeServer([])
        res = swap("http://s", "latest.gguf", 1.0, lambda: CheckResult(False, [], "empty reply"), srv)
        self.assertFalse(res.ok)
        self.assertTrue(res.reason.startswith("rolled back"))
        self.assertEqual(srv.adapters[0]["scale"], 1.0)
        self.assertEqual(srv.adapters[1]["scale"], 0.0)
        self.assertEqual(len(srv.posts), 2)

    def test_swap_missing_adapter(self):
        srv = FakeServer([])
        res = swap("http://s", "nope.gguf", 1.0, lambda: CheckResult(True, []), srv)
        self.assertFalse(res.ok)
        self.assertEqual(srv.posts, [])

    def test_prune(self):
        d = Path(tempfile.mkdtemp())
        for i in range(4):
            (d / f"adapter-2026010{i}-000000.gguf").write_text("")
        removed = prune(d, 2)
        self.assertEqual([p.name for p in removed], ["adapter-20260100-000000.gguf", "adapter-20260101-000000.gguf"])
        self.assertEqual(len(list(d.glob("adapter-*.gguf"))), 2)


if __name__ == "__main__":
    unittest.main()
