import tests  # noqa: F401  isolates REVERIE_* before reverie is imported
import io
import datetime
import json
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace

from reverie import sleep

NIGHT = 1_800_000_000.0 - (1_800_000_000 % 86400) + 2 * 3600       # 02:00 UTC
DAY = NIGHT + 10 * 3600                                              # 12:00 UTC


def msg(mid, at_s, text, session=None, user=False, name="Member"):
    sender = {"kind": "user", "name": "user"} if user else {"kind": "agent", "sessionId": session, "name": name}
    return {"id": mid, "at": at_s * 1000, "from": sender, "to": "all", "text": text}


class FakeStore:
    def __init__(self):
        self.state, self.episodes, self.dream, self.insights = {}, {}, None, []

    def get_state(self, key, default=None): return self.state.get(key, default)
    def set_state(self, key, value): self.state[key] = value
    def add_external_episode(self, source, user, reply, visibility):
        self.episodes.setdefault(source, (user, reply))
    def latest_dream(self): return self.dream
    def reflections(self): return self.insights


class Fixture:
    def __init__(self, dry_run=False, agents=None, drop_chatrooms=False, **policy):
        self.tmp = Path(tempfile.mkdtemp())
        raw = {"timezone": "UTC", "window": {"start": "01:00", "end": "06:00"}, "dry_run": dry_run,
               "chatrooms": str(self.tmp / "chatrooms.json"), "state_dir": str(self.tmp / "state"),
               "agents": agents if agents is not None else [{"name": "expert", "instance": "/x/expert.json", "session_id": "S1"},
                                    {"name": "assistant", "instance": "/x/assistant.json", "consolidate": False}], **policy}
        if drop_chatrooms:
            del raw["chatrooms"]
        (self.tmp / "policy.json").write_text(json.dumps(raw))
        self.policy = sleep.load_policy(self.tmp / "policy.json")
        self.stores = {"/x/expert.json": FakeStore(), "/x/assistant.json": FakeStore()}
        self.results = {"/x/expert.json": ["rated", "reflected", "dreamed"], "/x/assistant.json": ["idle"]}
        self.due = {"reflect": True, "dream": False}
        self.api_base = "http://169.254.1.2:8080/v1"
        self.embed_url = ""
        self.opened = []
        self.calls, self.lines = [], []

    def brain_for(self, instance):
        outer = self

        @contextmanager
        def opened():
            if instance == "/x/broken.json":
                raise RuntimeError("store unreadable")
            store = outer.stores[instance]
            outer.opened.append(instance)
            yield SimpleNamespace(store=store, cfg=SimpleNamespace(data_dir=outer.tmp, api_base=outer.api_base, embed_url=""),
                                  reflector=SimpleNamespace(due=lambda now: outer.due["reflect"]),
                                  dreamer=SimpleNamespace(due=lambda last, now: outer.due["dream"]),
                                  instance=instance)
        return opened()

    def dispatch(self, brain, request):
        self.calls.append((brain.instance, request["action"]))
        queue = self.results[brain.instance]
        action = queue.pop(0) if queue else "idle"
        if action == "dreamed":
            brain.store.dream = SimpleNamespace(created_at=NIGHT, recall="I walked a long corridor of servers.", meta={})
            brain.store.insights = [SimpleNamespace(created_at=NIGHT - i, text="insight %d " % i + "x" * 300) for i in range(5)]
        return {"action": action, "count": {"rated": 3, "reflected": 2, "dreamed": 1}.get(action, 0)}

    def tick(self, rooms, now=NIGHT, clock=None):
        before = len(self.lines)
        sleep.Sleep(self.policy, self.lines.append, now, rooms=rooms, brain_for=self.brain_for, dispatch=self.dispatch,
                    config_for=lambda instance: SimpleNamespace(api_base=self.api_base, embed_url=self.embed_url),
                    **({"clock": clock} if clock else {})).run()
        return [(l.split()[3], l.split()[4], int(l.split()[5])) for l in self.lines[before:]
                if l.split()[3] != "deprecated_session_ids"]  # covered by EmployeeTest


MEMBERS = [{"sessionId": "S1"}, {"sessionId": "S2"}]
ROOMS = [
    {"name": "platform", "members": MEMBERS, "messages": [
        msg("m1", NIGHT - 900, "status of the build?", user=True),
        msg("m2", NIGHT - 890, "other agent note", session="S2", name="Other"),
        msg("m3", NIGHT - 880, "the build is green", session="S1"),
        msg("m4", NIGHT - 870, "thanks", user=True),
        msg("m5", NIGHT - 860, "", session="S1")]},
    {"name": "", "dm": True, "members": MEMBERS, "messages": [msg("d1", NIGHT - 850, "private aside", session="S1")]},
    {"name": "lounge", "members": MEMBERS, "messages": [msg("b1", NIGHT - 840, "coffee is ready", session="S1")]},
]


class PolicyTest(unittest.TestCase):
    def test_refusals(self):
        for bad in ({"surprise": 1}, {"chat_db": "/abs/chat.db"}, {"chatrooms": None, "chat_db": "relative.db"}, {"timezone": "Mars/Base"}, {"window": {"start": "25:00", "end": "06:00"}},
                    {"chatrooms": "relative.json"}, {"agents": []},
                    {"agents": [{"name": "a", "instance": "/i"}]},                      # consolidation without a session
                    {"agents": [{"name": "a", "instance": "/i", "consolidate": False, "extra": 1}]},
                    {"agents": [{"name": "a", "instance": "/i", "consolidate": False}] * 2},
                    {"agents": [{"name": "reviewer Smith", "instance": "/i", "consolidate": False}]},  # not a slug
                    {"agents": [{"name": "a", "instance": "/i", "session_ids": "S1"}]},
                    {"agents": [{"name": "a", "instance": "/i", "session_ids": [""]}]},
                    {"agents": [{"name": "a", "instance": "/i", "session_ids": []}]}):
            with self.assertRaises(sleep.PolicyError, msg=bad):
                if bad.get("chatrooms", 1) is None:
                    Fixture(drop_chatrooms=True, chat_db=bad["chat_db"])
                else:
                    Fixture(**bad) if "agents" not in bad else Fixture(agents=bad["agents"])

    def test_dry_run_is_the_default(self):
        f = Fixture()
        raw = json.loads((f.tmp / "policy.json").read_text()); del raw["dry_run"]
        (f.tmp / "policy.json").write_text(json.dumps(raw))
        self.assertTrue(sleep.load_policy(f.tmp / "policy.json")["dry_run"])

    def test_windows_including_one_across_midnight(self):
        f = Fixture()
        self.assertTrue(sleep.in_window(f.policy, NIGHT))
        self.assertFalse(sleep.in_window(f.policy, DAY))
        g = Fixture(window={"start": "22:00", "end": "06:00"})
        self.assertTrue(sleep.in_window(g.policy, NIGHT))
        self.assertTrue(sleep.in_window(g.policy, NIGHT - 3.5 * 3600))                # 22:30
        self.assertFalse(sleep.in_window(g.policy, DAY))


class EpisodeTest(unittest.TestCase):
    def test_own_posts_with_prior_context_no_dms_no_blanks(self):
        episodes = sleep.room_episodes(ROOMS, "S1", 0)
        self.assertEqual([e["source"] for e in episodes], ["room:m3", "room:b1"])
        self.assertEqual(episodes[0]["reply"], "the build is green")
        self.assertIn("Owner: status of the build?", episodes[0]["user"])
        self.assertIn("Other: other agent note", episodes[0]["user"])
        self.assertTrue(episodes[0]["user"].startswith("[platform]"))
        self.assertEqual(sleep.room_episodes(ROOMS, "S1", (NIGHT - 880) * 1000)[0]["source"], "room:b1")

    def test_only_rooms_listing_one_of_the_agents_sessions(self):
        rooms = [{"name": "private", "members": [{"sessionId": "S2"}], "messages": [msg("x1", NIGHT - 99, "not mine", session="S1")]},
                 {"name": "no members", "messages": [msg("x2", NIGHT - 98, "unknown room", session="S1")]},
                 {"name": "old seat", "members": [{"sessionId": "OLD"}], "messages": [
                     msg("x3", NIGHT - 97, "hello", user=True), msg("x4", NIGHT - 96, "from my old session", session="OLD"),
                     msg("x5", NIGHT - 95, "and from the new one", session="S1"),
                     dict(msg("x6", NIGHT - 94, "deleted", session="S1"), deleted={"at": 1, "by": "owner"})]}]
        self.assertEqual(sleep.room_episodes(rooms, "S1", 0), [])
        episodes = sleep.room_episodes(rooms, ["S1", "OLD"], 0)
        self.assertEqual([e["source"] for e in episodes], ["room:x4", "room:x5"])
        self.assertNotIn("from my old session", episodes[1]["user"])       # its own posts are never context


def make_chat_db(path, rooms):
    import sqlite3
    db = sqlite3.connect(path)
    db.execute("CREATE TABLE rooms(id TEXT PRIMARY KEY, data TEXT NOT NULL)")
    db.execute("CREATE TABLE messages(room_id TEXT NOT NULL, id TEXT NOT NULL, at INTEGER NOT NULL, data TEXT NOT NULL,"
               " PRIMARY KEY(room_id, id))")
    for index, room in enumerate(rooms):
        room_id = "room%d" % index
        body = {k: v for k, v in room.items() if k != "messages"}
        db.execute("INSERT INTO rooms VALUES (?, ?)", (room_id, json.dumps(dict(body, id=room_id))))
        for m in room["messages"]:
            db.execute("INSERT INTO messages VALUES (?, ?, ?, ?)", (room_id, m["id"], int(m["at"]), json.dumps(dict(m, roomId=room_id))))
    db.commit()
    db.close()


class ChatDbTest(unittest.TestCase):
    ROOMS = ROOMS + [{"name": "other team", "members": [{"sessionId": "S9"}],
                      "messages": [msg("o1", NIGHT - 830, "their secret plan", session="S9"), msg("o2", NIGHT - 820, "x", session="S1")]}]

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.db = self.tmp / "chat.db"
        make_chat_db(self.db, self.ROOMS)

    def test_reads_only_member_rooms_read_only_with_context_before_the_mark(self):
        before = self.db.read_bytes()
        rooms = sleep.load_rooms_db(self.db, ["S1"], 0)
        self.assertEqual(sorted(r["name"] for r in rooms), ["lounge", "platform"])     # no dm, no other team
        self.assertEqual(self.db.read_bytes(), before)
        later = sleep.load_rooms_db(self.db, ["S1"], (NIGHT - 880) * 1000, context=2)
        platform = [r for r in later if r["name"] == "platform"][0]
        self.assertEqual([m["id"] for m in platform["messages"]], ["m2", "m3", "m4", "m5"])
        self.assertEqual([e["source"] for e in sleep.room_episodes(later, ["S1"], (NIGHT - 880) * 1000)], ["room:b1"])
        self.assertEqual(sleep.load_rooms_db(self.db, ["S1"], NIGHT * 1000), [])

    def test_the_reader_cannot_write(self):
        import sqlite3
        real, opened = sqlite3.connect, []

        class Spy:  # the reader's own connection, kept open so the test can try a write through it
            def __init__(self, db): self.db = db
            def execute(self, *a): return self.db.execute(*a)
            def close(self): opened.append(self.db)

        sleep.sqlite3.connect = lambda *a, **k: Spy(real(*a, **k))
        try:
            sleep.load_rooms_db(self.db, ["S1"], 0)
        finally:
            sleep.sqlite3.connect = real
        with self.assertRaises(sqlite3.OperationalError):
            opened[0].execute("DELETE FROM messages")
        opened[0].close()

    def test_a_dry_run_tick_counts_from_the_database_and_stores_nothing(self):
        f = Fixture(dry_run=True, drop_chatrooms=True, chat_db=str(self.db),
                    agents=[{"name": "expert", "instance": "/x/expert.json", "session_ids": ["OLD", "S1"]}])
        self.assertIsNone(f.policy["chatrooms"])
        out = f.tick(None)
        self.assertEqual(out[0], ("would_consolidate", "expert", 2))
        self.assertEqual(f.stores["/x/expert.json"].episodes, {})

    def test_a_backlog_is_taken_in_chunks_oldest_first(self):
        f = Fixture(drop_chatrooms=True, chat_db=str(self.db), agents=[{"name": "expert", "instance": "/x/expert.json", "session_id": "S1"}])
        old, sleep.EPISODES_PER_PASS = sleep.EPISODES_PER_PASS, 1
        try:
            self.assertEqual([f.tick(None)[0] for _ in range(3)],
                             [("consolidated", "expert", 1), ("consolidated", "expert", 1), ("consolidated", "expert", 0)])
        finally:
            sleep.EPISODES_PER_PASS = old
        self.assertEqual(sorted(f.stores["/x/expert.json"].episodes), ["room:b1", "room:m3"])

    def test_a_dry_run_counts_the_whole_backlog_not_one_chunk(self):
        f = Fixture(dry_run=True, drop_chatrooms=True, chat_db=str(self.db),
                    agents=[{"name": "expert", "instance": "/x/expert.json", "session_id": "S1"}])
        old, sleep.EPISODES_PER_PASS = sleep.EPISODES_PER_PASS, 1
        try:
            self.assertEqual([f.tick(None)[0] for _ in range(2)], [("would_consolidate", "expert", 2)] * 2)
        finally:
            sleep.EPISODES_PER_PASS = old

    def test_a_chunk_never_splits_posts_with_the_same_timestamp(self):
        db = self.tmp / "tie.db"
        make_chat_db(db, [{"name": "r", "members": MEMBERS, "messages": [
            msg("t1", NIGHT - 50, "first", session="S1"), msg("t2", NIGHT - 50, "same ms", session="S1"),
            msg("t3", NIGHT - 40, "later", session="S1")]}])
        f = Fixture(drop_chatrooms=True, chat_db=str(db), agents=[{"name": "expert", "instance": "/x/expert.json", "session_id": "S1"}])
        old, sleep.EPISODES_PER_PASS = sleep.EPISODES_PER_PASS, 1
        try:
            self.assertEqual([f.tick(None)[0][2] for _ in range(3)], [2, 1, 0])
        finally:
            sleep.EPISODES_PER_PASS = old
        self.assertEqual(sorted(f.stores["/x/expert.json"].episodes), ["room:t1", "room:t2", "room:t3"])

    def test_backfill_days_bounds_the_first_pass(self):
        agents = [{"name": "expert", "instance": "/x/expert.json", "session_id": "S1"}]
        f = Fixture(drop_chatrooms=True, chat_db=str(self.db), agents=agents, backfill_days=1)
        self.assertEqual(f.tick(None, now=NIGHT + 86400 - 845)[0], ("consolidated", "expert", 1))   # m3 is older than a day
        self.assertEqual(sorted(f.stores["/x/expert.json"].episodes), ["room:b1"])
        for bad in (0, 1.5, True, "7"):
            with self.assertRaises(sleep.PolicyError):
                Fixture(backfill_days=bad)

    def test_a_live_tick_stores_member_room_episodes_once(self):
        f = Fixture(drop_chatrooms=True, chat_db=str(self.db), agents=[{"name": "expert", "instance": "/x/expert.json", "session_id": "S1"}])
        self.assertEqual(f.tick(None)[0], ("consolidated", "expert", 2))
        self.assertEqual(sorted(f.stores["/x/expert.json"].episodes), ["room:b1", "room:m3"])
        self.assertEqual(f.tick(None)[0], ("consolidated", "expert", 0))


class LiveGateTest(unittest.TestCase):
    def test_other_members_contact_details_never_enter_memory(self):
        rooms = [{"name": "r", "members": MEMBERS, "messages": [msg("c1", NIGHT - 90, "Call Jane Roe at 555-123-4567", session="S2", name="Other"),
                                            msg("c2", NIGHT - 80, "what is the plan?", user=True),
                                            msg("c3", NIGHT - 70, "the plan is ready", session="S1")]}]
        episode = sleep.room_episodes(rooms, "S1", 0)[0]
        self.assertIn("what is the plan?", episode["user"])
        self.assertNotIn("555-123-4567", episode["user"])
        self.assertNotIn("Jane Roe", episode["user"])

    def test_only_local_model_endpoints(self):
        for url in ("", "http://127.0.0.1:8080/v1", "http://localhost:8080/v1", "http://169.254.1.2:8080/v1", "http://[::1]:8080"):
            self.assertTrue(sleep.local_endpoint(url), url)
        for url in ("https://api.example.com/v1", "http://10.0.0.5:8080/v1", "http://8.8.8.8/v1", "http://example/"):
            self.assertFalse(sleep.local_endpoint(url), url)
        for dry in (False, True):
            for field, url in (("api_base", "https://api.example.com/v1"), ("embed_url", "https://embed.example.com/v1")):
                f = Fixture(dry_run=dry)
                setattr(f, field, url)
                out = f.tick(ROOMS)
                self.assertEqual(out, [("refused_remote_model", "expert", 0), ("refused_remote_model", "assistant", 0)])
                self.assertEqual(f.opened, [])          # no store or embedder was opened, so nothing was embedded or sent
                self.assertEqual(f.calls, [])
                self.assertEqual(f.stores["/x/expert.json"].episodes, {})

    def test_a_failed_dream_releases_the_gpu_hold(self):
        from tests.test_chat import make_brain
        brain, _, _ = make_brain()
        brain.dreamer.due = lambda *a, **k: True
        def broken(*a, **k):
            raise RuntimeError("model down")
        brain.dreamer.dream = broken
        with self.assertRaises(RuntimeError):
            brain.dream_if_due()
        self.assertTrue(brain.gpu_dream.acquire(timeout=0))                             # free again
        brain.gpu_dream.release()


class PruneTest(unittest.TestCase):
    NAME = ".reverie-relay-log.jsonl"

    def setup(self, live=True, global_dry_run=True, tail=b""):
        f = Fixture(dry_run=global_dry_run)
        log = f.tmp / self.NAME
        iso = lambda t: datetime.datetime.fromtimestamp(t, datetime.timezone.utc).isoformat().replace("+00:00", "Z")
        rows = [json.dumps({"at": iso(NIGHT - 9 * 86400), "text": "old"}), json.dumps({"at": iso(NIGHT - 7 * 86400 - 1), "text": "just old"}),
                "not json at all", json.dumps({"text": "no stamp"}), json.dumps({"at": None, "text": "null stamp"}),
                json.dumps({"at": iso(NIGHT - 7 * 86400 + 1), "text": "just kept"}), json.dumps({"at": iso(NIGHT - 60), "text": "new"})]
        log.write_bytes(("\n".join(rows) + "\n").encode() + tail)
        log.chmod(0o644)
        f.policy["prune"] = [{"path": log, "days": 7, "live": live}]
        return f, log

    def texts(self, log):
        return [json.loads(line)["text"] for line in log.read_text().splitlines()]

    def test_policy_accepts_and_refuses_prune_entries(self):
        good = Fixture(prune=[{"path": "/abs/log.jsonl", "days": 7}, {"path": "/abs/b", "days": 1, "live": True}])
        self.assertEqual(good.policy["prune"], [{"path": Path("/abs/log.jsonl"), "days": 7, "live": False},
                                                {"path": Path("/abs/b"), "days": 1, "live": True}])
        self.assertEqual(Fixture().policy["prune"], [])
        for bad in ([{"path": "rel.jsonl", "days": 7}], [{"path": "/a", "days": 0}], [{"path": "/a", "days": 7.5}],
                    [{"path": "/a", "days": True}], [{"path": "/a"}], [{"path": "/a", "days": 7, "extra": 1}],
                    [{"path": "/a", "days": 7, "live": "yes"}], [{"path": "/a", "days": 7, "live": 1}], {"path": "/a"}):
            with self.assertRaises(sleep.PolicyError):
                Fixture(prune=bad)

    def test_live_drops_old_and_unstamped_lines_and_rewrites_at_0600(self):
        f, log = self.setup()
        out = f.tick(ROOMS)
        self.assertEqual(out[0], ("pruned", self.NAME, 5))
        self.assertEqual(self.texts(log), ["just kept", "new"])
        self.assertEqual(log.stat().st_mode & 0o777, 0o600)
        self.assertFalse((f.tmp / (self.NAME + ".prune-tmp")).exists())
        self.assertEqual(f.tick(ROOMS)[0], ("pruned", self.NAME, 0))   # idempotent

    def test_only_the_entry_flag_makes_it_live_never_the_global_dry_run(self):
        for live, global_dry_run, code in ((False, False, "would_prune"), (False, True, "would_prune"), (True, True, "pruned")):
            f, log = self.setup(live=live, global_dry_run=global_dry_run)
            before = log.read_bytes()
            self.assertEqual(f.tick(ROOMS)[0], (code, self.NAME, 5))
            self.assertEqual(log.read_bytes() == before, not live)

    def test_a_trailing_partial_line_is_kept_one_night_then_dropped_if_unchanged(self):
        f, log = self.setup(tail=b'{"at": "20')
        self.assertEqual(f.tick(ROOMS)[0], ("pruned", self.NAME, 5))
        self.assertTrue(log.read_bytes().endswith(b'\n{"at": "20'))
        self.assertEqual(f.tick(ROOMS)[0], ("pruned", self.NAME, 1))           # same tail next night
        self.assertEqual(self.texts(log), ["just kept", "new"])
        self.assertEqual(list(f.tmp.glob("**/prune-tail-*")), [])

    def test_a_partial_line_that_changed_gets_another_night(self):
        f, log = self.setup(tail=b'{"at": "20')
        f.tick(ROOMS)
        with open(log, "ab") as more:
            more.write(b"26-")
        self.assertEqual(f.tick(ROOMS)[0], ("pruned", self.NAME, 0))
        self.assertTrue(log.read_bytes().endswith(b'{"at": "2026-'))

    def test_same_named_logs_in_different_folders_keep_separate_tail_marks(self):
        f, log = self.setup(tail=b"partial-a")
        other = f.tmp / "other" / self.NAME
        other.parent.mkdir()
        other.write_bytes(b"partial-b")
        f.policy["prune"].append({"path": other, "days": 7, "live": True})
        f.tick(ROOMS)
        other.write_bytes(b"partial-a")   # the other log now ends with the tail the first one had
        self.assertEqual(f.tick(ROOMS)[:2], [("pruned", self.NAME, 1), ("pruned", self.NAME, 0)])
        self.assertEqual(other.read_bytes(), b"partial-a")

    def test_a_dry_run_leaves_the_tail_mark_alone(self):
        f, log = self.setup(live=False, tail=b"partial")
        for _ in range(2):
            self.assertEqual(f.tick(ROOMS)[0], ("would_prune", self.NAME, 5))
        self.assertEqual(list(f.tmp.glob("**/prune-tail-*")), [])

    def test_outside_the_window_and_a_missing_log_do_nothing(self):
        f, log = self.setup()
        before = log.read_bytes()
        self.assertEqual(f.tick(ROOMS, now=DAY), [("outside_window", "-", 0)])
        self.assertEqual(log.read_bytes(), before)
        log.unlink()
        self.assertNotIn("pruned", [code for code, _, _ in f.tick(ROOMS)])

    def test_lines_appended_during_the_rewrite_are_kept(self):
        f, log = self.setup()
        real = Path.read_bytes
        calls = []
        def racing(path):
            data = real(path)
            if path == log and not calls:
                calls.append(1)
                with open(log, "ab") as extra:
                    extra.write(b'{"at": "2099-01-01T00:00:00Z", "text": "late"}\n')
            return data
        Path.read_bytes = racing
        try:
            f.tick(ROOMS)
        finally:
            Path.read_bytes = real
        self.assertEqual(self.texts(log), ["just kept", "new", "late"])

    def test_a_prune_failure_is_reported_and_the_agents_still_run(self):
        f, log = self.setup()
        bad = f.tmp / "relay-dir"
        bad.mkdir()
        f.policy["prune"] = [{"path": bad, "days": 7, "live": True}, {"path": log, "days": 7, "live": True}]
        out = f.tick(ROOMS)
        self.assertEqual(out[0], ("error_prune_IsADirectoryError", "relay-dir", 0))
        self.assertEqual(out[1], ("pruned", self.NAME, 5))
        self.assertEqual(out[2], ("would_consolidate", "expert", 2))


class TickTest(unittest.TestCase):
    def test_outside_the_window_does_nothing(self):
        f = Fixture()
        self.assertEqual(f.tick(ROOMS, now=DAY), [("outside_window", "-", 0)])
        self.assertEqual(f.calls, [])

    def test_live_night_consolidates_once_reflects_dreams_and_leaves_a_short_note(self):
        f = Fixture()
        out = f.tick(ROOMS)
        note_len = out[4][2]
        self.assertEqual(out, [("consolidated", "expert", 2), ("rated", "expert", 3), ("reflected", "expert", 2),
                               ("dreamed", "expert", 1), ("morning_note", "expert", note_len), ("idle", "assistant", 0)])
        self.assertLessEqual(note_len, sleep.NOTE_CHARS)
        store = f.stores["/x/expert.json"]
        self.assertEqual(sorted(store.episodes), ["room:b1", "room:m3"])
        self.assertEqual(float(store.state["reverie_last_activity"]), NIGHT - 840)
        note = (f.tmp / "morning-note.md").read_text()
        self.assertTrue(note.startswith("Dream ("))
        self.assertIn("corridor of servers", note)
        self.assertLessEqual(len(note.strip()), sleep.NOTE_CHARS)
        insight_lines = [line for line in note.splitlines() if line.startswith("- insight")]
        self.assertTrue(insight_lines)
        for line in insight_lines:  # whole insight lines only, never a half one
            self.assertTrue(line.endswith("x" * 300), line[-20:])
        self.assertNotIn("consolidated", [c for c, a, _ in out if a == "assistant"])   # its runtime records its own turns
        out = f.tick(ROOMS)
        self.assertEqual(out[0], ("consolidated", "expert", 0))                            # nothing stored twice

    def test_dry_run_decides_without_storing_or_calling_the_model(self):
        f = Fixture(dry_run=True)
        out = f.tick(ROOMS)
        self.assertEqual(out, [("would_consolidate", "expert", 2), ("would_reflect", "expert", 0),
                               ("would_reflect", "assistant", 0)])
        f.due["reflect"] = False
        self.assertEqual(f.tick(ROOMS)[1:], [("nothing_due", "expert", 0), ("nothing_due", "assistant", 0)])
        f.due.update(reflect=True, dream=True)
        self.assertEqual(f.tick(ROOMS)[1], ("would_reflect_dream", "expert", 0))
        self.assertEqual(f.calls, [])
        self.assertEqual(f.stores["/x/expert.json"].episodes, {})
        self.assertFalse((f.tmp / "morning-note.md").exists())

    def test_floor_refused_posts_are_not_stored(self):
        f = Fixture()
        rooms = [{"name": "r", "members": MEMBERS, "messages": [msg("p1", NIGHT - 60, "Call Jane Roe at 555-123-4567", session="S1"),
                                            msg("p2", NIGHT - 30, "fine text", session="S1")]}]
        self.assertEqual(f.tick(rooms)[0], ("consolidated", "expert", 1))
        self.assertEqual(list(f.stores["/x/expert.json"].episodes), ["room:p2"])

    def test_one_failing_agent_does_not_stop_the_others(self):
        f = Fixture(agents=[{"name": "broken", "instance": "/x/broken.json", "consolidate": False},
                            {"name": "assistant", "instance": "/x/assistant.json", "consolidate": False}])
        self.assertEqual(f.tick(ROOMS), [("error_RuntimeError", "broken", 0), ("idle", "assistant", 0)])

    def test_a_skipped_maintenance_ends_that_agent_and_no_note_without_a_dream(self):
        f = Fixture()
        f.results["/x/expert.json"] = ["rated", "skipped"]
        self.assertEqual(f.tick(ROOMS)[1:3], [("rated", "expert", 3), ("skipped", "expert", 0)])
        self.assertFalse((f.tmp / "morning-note.md").exists())

    def test_the_pass_budget_stops_further_work(self):
        f = Fixture()
        ticks = iter([0, 0, 0, 0, 0, 10_000, 10_000, 10_000])
        out = f.tick(ROOMS, clock=lambda: next(ticks))
        self.assertIn(("pass_budget_spent", "assistant", 0), out)


class ExampleTest(unittest.TestCase):
    def test_the_shipped_example_loads_and_starts_as_a_dry_run(self):
        policy = sleep.load_policy(Path(__file__).resolve().parent.parent / "examples" / "sleep.json")
        self.assertTrue(policy["dry_run"])


class LogTest(unittest.TestCase):
    def test_a_tick_appends_its_report_lines_to_the_state_dir_log(self):
        f = Fixture()
        (f.tmp / "chatrooms.json").write_text("[]")  # the tick runs at the real time, which may fall in the window
        out = io.StringIO()
        self.assertEqual(sleep.main(["tick", "--policy", str(f.tmp / "policy.json")], out=out), 0)
        logged = (f.tmp / "state" / "sleep.log").read_text().splitlines()
        self.assertEqual(logged, out.getvalue().splitlines())
        self.assertTrue(all(line.startswith("sleep v1 ") for line in logged))


class CommandLineTest(unittest.TestCase):
    def test_check_policy_and_refusal(self):
        f = Fixture()
        out = io.StringIO()
        self.assertEqual(sleep.main(["check-policy", "--policy", str(f.tmp / "policy.json")], out=out), 0)
        self.assertIn("policy ok: 2 agents, live", out.getvalue())
        (f.tmp / "bad.json").write_text('{"surprise": 1}')
        out = io.StringIO()
        self.assertEqual(sleep.main(["tick", "--policy", str(f.tmp / "bad.json")], out=out), 2)
        self.assertIn("policy_refused", out.getvalue())


if __name__ == "__main__":
    unittest.main()


E1, E2, E9 = ("%08x-0000-4000-8000-00000000000a" % n for n in (1, 2, 9))


def write_company(path, bindings):
    path.write_text(json.dumps({"version": 1, "employees": [{"id": e, "name": e[:8], "sessionId": s} for e, s in bindings.items()],
                                "retired": [{"id": E9, "name": "gone", "sessionId": "S9"}]}))


class EmployeeTest(unittest.TestCase):
    def fixture(self, agents, bindings, **policy):
        tmp = Path(tempfile.mkdtemp())
        write_company(tmp / "company.json", bindings)
        f = Fixture(agents=agents, company=str(tmp / "company.json"), **policy)
        f.company = tmp / "company.json"
        return f

    def test_policy_refuses_bad_or_unbacked_employee_ids(self):
        for agents, extra in (([{"name": "a", "instance": "/i", "employee_id": "coordinator"}], True),
                              ([{"name": "a", "instance": "/i", "employee_id": E1.upper()}], True),
                              ([{"name": "a", "instance": "/i", "employee_id": E1}], False),        # no company file
                              ([{"name": "a", "instance": "/i", "employee_id": E1},
                                {"name": "b", "instance": "/j", "employee_id": E1}], True)):
            with self.assertRaises(sleep.PolicyError, msg=agents):
                Fixture(agents=agents, **({"company": "/abs/company.json"} if extra else {}))
        with self.assertRaises(sleep.PolicyError):
            Fixture(agents=[{"name": "a", "instance": "/i", "employee_id": E1}], company="relative.json")

    def test_employee_id_resolves_to_the_current_session(self):
        f = self.fixture([{"name": "expert", "instance": "/x/expert.json", "employee_id": E1}], {E1: "S1", E2: "S2"})
        self.assertEqual(f.tick(ROOMS)[0], ("consolidated", "expert", 2))
        self.assertEqual(sorted(f.stores["/x/expert.json"].episodes), ["room:b1", "room:m3"])
        self.assertFalse([l for l in f.lines if "deprecated_session_ids" in l])
        remembered = f.policy["state_dir"] / "sleep-expert.sessions.json"
        self.assertEqual(json.loads(remembered.read_text()), ["S1"])
        self.assertEqual(remembered.stat().st_mode & 0o777, 0o600)

    def test_a_moved_session_resolves_to_the_new_id_without_a_policy_edit(self):
        f = self.fixture([{"name": "expert", "instance": "/x/expert.json", "employee_id": E1}], {E1: "OLD"})
        policy_bytes = (f.tmp / "policy.json").read_bytes()
        a1, a2, a3 = (msg("a1", NIGHT - 90, "before the move", session="OLD"),
                      msg("a2", NIGHT - 80, "last post from the old seat", session="OLD"),
                      msg("a3", NIGHT - 70, "first post from the new seat", session="NEW"))
        self.assertEqual(f.tick([{"name": "r", "members": [{"sessionId": "OLD"}], "messages": [a1]}])[0], ("consolidated", "expert", 1))
        write_company(f.company, {E1: "NEW"})                                       # the console moved the seat
        moved = [{"name": "r", "members": [{"sessionId": "NEW"}], "messages": [a1, a2, a3]}]   # rooms rebound too
        self.assertEqual(f.tick(moved)[0], ("consolidated", "expert", 2))         # a2 via the remembered old seat
        self.assertEqual(sorted(f.stores["/x/expert.json"].episodes), ["room:a1", "room:a2", "room:a3"])
        self.assertEqual((f.tmp / "policy.json").read_bytes(), policy_bytes)
        out = io.StringIO()
        self.assertEqual(sleep.main(["check-policy", "--policy", str(f.tmp / "policy.json")], out=out), 0)
        self.assertIn("resolved expert employee %s -> session NEW (2 known)" % E1[:8], out.getvalue())

    def test_a_legacy_session_id_entry_still_works_with_a_one_line_deprecation(self):
        f = Fixture()                                                                  # expert: session_id S1
        self.assertEqual(f.tick(ROOMS)[0], ("consolidated", "expert", 2))
        self.assertEqual([l.split()[3:6] for l in f.lines if "deprecated" in l], [["deprecated_session_ids", "expert", "1"]])
        out = io.StringIO()
        self.assertEqual(sleep.main(["check-policy", "--policy", str(f.tmp / "policy.json")], out=out), 0)
        self.assertIn("deprecated_session_ids expert: name these agents by employee_id", out.getvalue())
        mixed = self.fixture([{"name": "expert", "instance": "/x/expert.json", "employee_id": E1, "session_ids": ["OLD"]}], {E1: "S1"})
        self.assertEqual(mixed.tick(ROOMS)[0], ("consolidated", "expert", 2))    # listed ids are history, not deprecated
        self.assertFalse([l for l in mixed.lines if "deprecated" in l])

    def test_an_unknown_employee_is_skipped_with_a_line_and_the_others_still_run(self):
        agents = [{"name": "expert", "instance": "/x/expert.json", "employee_id": E9},     # retired: not an employee
                  {"name": "assistant", "instance": "/x/assistant.json", "consolidate": False}]
        f = self.fixture(agents, {E1: "S1"})
        self.assertEqual(f.tick(ROOMS), [("unknown_employee", "expert", 0), ("idle", "assistant", 0)])
        self.assertEqual(f.opened, ["/x/assistant.json"])
        self.assertEqual(f.stores["/x/expert.json"].state, {})                      # the mark never moved
        out = io.StringIO()
        self.assertEqual(sleep.main(["check-policy", "--policy", str(f.tmp / "policy.json")], out=out), 1)
        self.assertIn("unknown_employee expert " + E9, out.getvalue())
        self.assertIn("resolved 1 of 2 agents", out.getvalue())
        f.company.unlink()                                                            # an unreadable company file
        self.assertEqual(f.tick(ROOMS), [("error_company_FileNotFoundError", "company.json", 0),
                                         ("unknown_employee", "expert", 0), ("idle", "assistant", 0)])


class InstanceEmployeeIdTest(unittest.TestCase):
    """Regression: instance files gained employee_id on 10-19 and every agent's tick
    failed with error_ValueError from the instance loader before its store was opened."""

    def instance(self, tmp, **extra):
        path = tmp / "expert.json"
        path.write_text(json.dumps(dict({"id": "expert", "agent_name": "Expert", "owner_name": "Owner",
                                         "data_dir": str(tmp / "state-expert"), "persona": "Plain."}, **extra)))
        return path

    def test_an_instance_with_employee_id_loads_and_a_bad_one_is_still_refused(self):
        tmp = Path(tempfile.mkdtemp())
        self.assertEqual(sleep._config_for(str(self.instance(tmp, employee_id=E1))).instance.employee_id, E1)
        self.assertIsNone(sleep._config_for(str(self.instance(tmp))).instance.employee_id)
        for bad in ("coordinator", E1.upper(), 7):
            with self.assertRaises(ValueError):
                sleep._config_for(str(self.instance(tmp, employee_id=bad)))
        with self.assertRaises(ValueError):
            sleep._config_for(str(self.instance(tmp, surprise=1)))

    def run_tick(self, policy_employee):
        tmp = Path(tempfile.mkdtemp())
        path = str(self.instance(tmp, employee_id=E1))
        f = EmployeeTest().fixture([{"name": "expert", "instance": path, "employee_id": policy_employee}],
                                   {E1: "S1", E2: "S2"}, dry_run=True)
        f.stores[path], f.results[path] = FakeStore(), []
        sleep.Sleep(f.policy, f.lines.append, NIGHT, rooms=ROOMS, brain_for=f.brain_for, dispatch=f.dispatch).run()
        return [l.split()[3:5] for l in f.lines]

    def test_a_tick_with_the_real_instance_loader_no_longer_raises(self):
        self.assertEqual(self.run_tick(E1), [["would_consolidate", "expert"], ["would_reflect", "expert"]])

    def test_an_instance_bound_to_another_employee_is_refused(self):
        self.assertEqual(self.run_tick(E2), [["refused_employee_mismatch", "expert"]])


class ClipTest(unittest.TestCase):
    def test_cuts_at_a_sentence_or_line_end_within_the_limit(self):
        clip = sleep.clip_at_sentence
        self.assertEqual(clip("Short. Note.", 600), "Short. Note.")
        text = "First sentence here. Second sentence is long " + "y" * 40 + ". Third."
        self.assertEqual(clip(text, 30), "First sentence here.")
        self.assertTrue(clip(text, 60).endswith("\u2026"))  # its only sentence end is too early: a word cut instead
        self.assertEqual(clip("Line one\nline two goes on and on and on", 16), "Line one")
        self.assertEqual(clip("Exactly ends. More", 13), "Exactly ends.")
        words = "word " * 40
        cut = clip(words, 50)
        self.assertTrue(cut.endswith("\u2026"))
        self.assertLessEqual(len(cut), 50)
        self.assertFalse(cut[:-1].endswith(" "))
        self.assertLessEqual(len(clip("a" * 700)), sleep.NOTE_CHARS)
