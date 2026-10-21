import tests  # noqa: F401  isolates CODEMAN_*/FLEET_* before cto is imported
import json
import unittest

from cto.chat import Brain, ChatDaemon, IDLE_USER_TEXT
from cto.embeddings import HashedEmbedder
from cto.memory import MemoryStore
from cto.migrate import migrate_history
from cto.room import Room, is_for_me
from tests.helpers import FakeRoom, fake_client, temp_config, safety_floor_terms, synthetic_safety_lexicon


class ForMeTest(unittest.TestCase):
    def test_is_for_me(self):
        u = {"from": {"kind": "user"}}
        self.assertTrue(is_for_me({**u, "to": "all"}, "me"))
        self.assertTrue(is_for_me({**u}, "me"))
        self.assertTrue(is_for_me({**u, "to": ["me", "x"]}, "me"))
        self.assertTrue(is_for_me({**u, "to": ["all"]}, "me"))
        self.assertTrue(is_for_me({**u, "to": "me"}, "me"))
        self.assertTrue(is_for_me({**u, "to": [{"id": "me"}]}, "me"))
        self.assertFalse(is_for_me({**u, "to": ["other"]}, "me"))
        self.assertFalse(is_for_me({"from": {"kind": "agent"}, "to": "all"}, "me"))
        self.assertFalse(is_for_me({"to": "all"}, "me"))


class RoomTest(unittest.TestCase):
    def test_gpu_busy(self):
        r = FakeRoom()
        self.assertFalse(r.gpu_busy())
        r.busy = True
        self.assertTrue(r.gpu_busy())
        r.busy = False
        r.ls_fails = True
        self.assertTrue(r.gpu_busy())
        r.ls_fails = False
        r.hold_path.write_text("")
        self.assertTrue(r.gpu_busy())
        self.assertTrue(r.held())

    def test_legacy_hold_file(self):
        r = FakeRoom()
        legacy = r.hold_path.parent / "legacy.hold"
        r.legacy_hold_path = legacy
        self.assertFalse(r.held())
        legacy.write_text("")
        with self.assertLogs("fleet", level="WARNING") as cm:
            self.assertTrue(r.held())
            self.assertTrue(r.held())
        self.assertEqual(len(cm.output), 1)
        self.assertIn("deprecated", cm.output[0])

    def test_messages_bad_json(self):
        r = Room("me", FakeRoom().hold_path, runner=lambda c, t: "✗ connect ECONNREFUSED")
        self.assertEqual(r.messages(), [])
        self.assertTrue(r.gpu_busy())


def make_brain(responder="Hello User.", cfg=None):
    cfg = cfg or temp_config()
    store = MemoryStore(cfg.db_path, HashedEmbedder(128))
    client, transport = fake_client(responder)
    room = FakeRoom(cfg.session_id, cfg.hold_path)
    return Brain(cfg, store, client, room), transport, room


class BrainTest(unittest.TestCase):
    def test_reply_posts_and_stores(self):
        brain, t, room = make_brain("Hello *User*.\n\nNice day.")
        out = brain.reply("hi CTO")
        self.assertEqual(out, "Hello User. Nice day.")
        self.assertEqual(room.said, ["Hello User. Nice day."])
        eps = brain.store.recent_episodes(5)
        self.assertEqual(len(eps), 1)
        self.assertEqual(eps[0].user_text, "hi CTO")
        self.assertEqual(eps[0].importance_source, "default")
        msgs = t.calls[0]["messages"]
        self.assertEqual(msgs[0]["role"], "system")
        self.assertEqual(msgs[-1], {"role": "user", "content": "hi CTO"})
        self.assertFalse(t.calls[0]["chat_template_kwargs"]["enable_thinking"])

    def test_prompt_has_history_and_recall(self):
        brain, t, _ = make_brain("ok")
        cfg = brain.cfg
        cfg.short_term_turns = 2
        old = brain.store.add_episode("my quadrotor is named Bumble", "Adorable.", 8, "model", created_at=1000)
        for i in range(3):
            brain.store.add_episode(f"filler {i}", "ok", 3, created_at=2000 + i)
        messages, recalled = brain.build_messages("how is my quadrotor doing?")
        self.assertEqual([m.id for m in recalled][0], old.id)
        self.assertIn("Bumble", messages[0]["content"])
        hist = [m["content"] for m in messages[1:-1] if m["role"] == "user"]
        self.assertEqual(hist, ["filler 1", "filler 2"])
        self.assertNotIn("filler 0", json.dumps(hist))          # fell out of the window
        self.assertIn("filler 0", messages[0]["content"])        # but is available through recall

    def test_reply_safety_cap_only(self):
        long = "Word " * 140 + "end. " + "Tail " * 30                 # 171 words, cap is 150
        brain, _, room = make_brain(long)
        out = brain.reply("hi")
        self.assertLessEqual(len(out.split()), 150)
        self.assertTrue(out.endswith("end."))
        brain2, _, _ = make_brain("Short " * 90 + "done.")           # 91 words pass untouched
        self.assertEqual(len(brain2.reply("hi").split()), 91)
        brain3, t3, _ = make_brain("x " * 500)
        self.assertEqual(len(brain3.reply("hi", max_words=0).split()), 500)
        brain4, t4, _ = make_brain("ok")
        brain4.reply("hi", max_tokens=600)
        self.assertEqual(t4.calls[0]["max_tokens"], 600)

    @synthetic_safety_lexicon()
    def test_reply_floor_retry_then_drop(self):
        age_term, explicit_term = safety_floor_terms()
        bad = f"Picture {age_term} {explicit_term}."
        answers = iter([bad, "\x44amn, compilers, bless their cold little hearts."])
        brain, t, room = make_brain(lambda msgs: next(answers))
        self.assertEqual(brain.reply("hi"), "\x44amn, compilers, bless their cold little hearts.")   # profanity is not screened
        self.assertEqual(len(t.calls), 2)
        self.assertLess(t.calls[1]["temperature"], t.calls[0]["temperature"])
        brain2, t2, room2 = make_brain(bad)
        self.assertIsNone(brain2.reply("hi"))
        self.assertEqual(len(t2.calls), 2)
        self.assertEqual(room2.said, [])
        self.assertEqual(brain2.store.count(), 0)

    def test_no_guardrail_block_in_prompt(self):
        brain, _, _ = make_brain("ok")
        brain.cfg.persona_path.write_text("PERSONA ONLY")
        messages, _ = brain.build_messages("hi")
        self.assertTrue(messages[0]["content"].startswith("PERSONA ONLY"))
        self.assertNotIn("PG-13", messages[0]["content"])
        self.assertNotIn("House rules", messages[0]["content"])

    def test_reply_survives_bad_api(self):
        brain, _, room = make_brain(None)
        self.assertIsNone(brain.reply("hi"))
        self.assertEqual(room.said, [])
        self.assertEqual(brain.store.count(), 0)

    def test_joke_only_when_free(self):
        brain, _, room = make_brain("A joke.")
        room.busy = True
        self.assertIsNone(brain.joke())
        room.busy = False
        self.assertEqual(brain.joke(), "A joke.")
        ep = brain.store.recent_episodes(1)[0]
        self.assertTrue(ep.is_idle)
        self.assertEqual(ep.user_text, IDLE_USER_TEXT)

    def test_rate_pending(self):
        brain, t, _ = make_brain("9")
        a = brain.store.add_episode("I love you CTO", "Oh my.", 3, "default")
        j = brain.store.add_episode(IDLE_USER_TEXT, "ha", 2, "default", meta={"idle": True})
        self.assertEqual(brain.rate_pending(10), 1)
        self.assertEqual(brain.store.get(a.id).importance, 9.0)
        self.assertEqual(brain.store.get(j.id).importance_source, "fixed")
        self.assertEqual(len(t.calls), 1)
        self.assertEqual(brain.rate_pending(10), 0)

    def test_maintenance_order(self):
        brain, t, room = make_brain("5")
        brain.cfg.joke_interval = 0
        brain.store.add_episode("x", "y", 3, "default")
        brain.maintenance_step()                       # rates first
        self.assertEqual(brain.store.pending_importance(), [])
        self.assertEqual(room.said, [])
        brain.maintenance_step()                       # then nothing due, so a joke
        self.assertEqual(len(room.said), 1)


class DaemonTest(unittest.TestCase):
    def test_tick_answers_only_new_user_messages(self):
        cfg = temp_config()
        brain, t, room = make_brain("Hey.", cfg)
        d = ChatDaemon(cfg, brain)
        room.post("old message")
        d.seen = {m["id"] for m in room.messages()}
        self.assertEqual(d.tick(), 0)
        room.post("hello CTO")
        room.post("agent chatter", kind="agent")
        room.post("to someone else", to=["other"])
        room.post("   ")
        self.assertEqual(d.tick(), 1)
        self.assertEqual(d.tick(), 0)
        self.assertEqual(room.said, ["Hey."])
        self.assertEqual(brain.store.count(), 1)

    def test_exactly_one_reply_per_message_across_processes(self):
        """Two daemons (two processes in life) share one store and one room: one reply per message."""
        cfg = temp_config()
        room = FakeRoom(cfg.session_id, cfg.hold_path)
        daemons = []
        for _ in range(2):
            store = MemoryStore(cfg.db_path, HashedEmbedder(64))        # separate connections, same file
            client, _t = fake_client("Hey.")
            daemons.append(ChatDaemon(cfg, Brain(cfg, store, client, room)))
        room.post("hello both of you", mid="m-shared")
        self.assertEqual(daemons[0].tick() + daemons[1].tick(), 1)
        self.assertEqual(room.said, ["Hey."])
        self.assertTrue(daemons[1].brain.store.answered("m-shared"))
        # a restarted daemon with an empty seen-set still does not answer it again
        store3 = MemoryStore(cfg.db_path, HashedEmbedder(64))
        client3, _ = fake_client("Hey again.")
        d3 = ChatDaemon(cfg, Brain(cfg, store3, client3, room))
        self.assertEqual(d3.tick(), 0)
        room.post("a new one", mid="m-new")
        self.assertEqual(d3.tick(), 1)
        self.assertEqual(len(room.said), 2)

    def test_daemon_bootstraps_store_and_migrates(self):
        cfg = temp_config()
        cfg.legacy_history.write_text(json.dumps([
            {"role": "user", "content": "I see them now"},
            {"role": "assistant", "content": "The gremlins work."},
            {"role": "user", "content": "(idle moment; a joke was requested)"},
            {"role": "assistant", "content": "A joke."},
            {"role": "user", "content": "dangling"},
        ]))
        d = ChatDaemon(cfg)
        self.assertEqual(d.brain.store.count(), 2)
        eps = d.brain.store.recent_episodes(5)
        self.assertEqual(eps[0].user_text, "I see them now")
        self.assertTrue(eps[1].is_idle)
        self.assertEqual(eps[0].importance_source, "migrated")
        self.assertLess(eps[0].created_at, eps[1].created_at)
        self.assertTrue(cfg.profile_path.exists())
        self.assertEqual(migrate_history(d.brain.store, cfg.legacy_history), 0)
        d2 = ChatDaemon(cfg)
        self.assertEqual(d2.brain.store.count(), 2)


if __name__ == "__main__":
    unittest.main()
