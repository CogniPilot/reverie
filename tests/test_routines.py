import tests  # noqa: F401  isolates REVERIE_* before reverie is imported
import datetime as dt
import io
import json
import os
import random
import signal
import re
import tempfile
import signal
import unittest
from unittest import mock
from pathlib import Path
from zoneinfo import ZoneInfo

from reverie import routines
from reverie import routines as routines_module
from reverie.routines import TEMPLATES, Console, PolicyError, State, Tick, load_policy, main

ZONE = ZoneInfo("America/Chicago")
MIN = 60_000


def local(*args):
    return dt.datetime(*args, tzinfo=ZONE).astimezone(dt.timezone.utc)


class FakeConsole:
    """Records every call. `fresh` overrides what the per-session re-check returns."""
    def __init__(self, sessions, fresh=None, cron=0, plan=None):
        self.sessions_value, self.fresh, self.calls, self.token, self.fail_send = sessions, fresh, [], "tok", False
        self.cron, self.plan = cron, plan

    def cron_jobs(self):
        self.calls.append(("GET", "/api/cron/jobs"))
        if isinstance(self.cron, Exception): raise self.cron
        return self.cron

    def plan_usage(self):
        self.calls.append(("GET", "/api/subscription-profiles/usage"))
        if isinstance(self.plan, Exception): raise self.plan
        return self.plan

    def sessions(self):
        self.calls.append(("GET", "/api/v1/sessions"))
        if isinstance(self.sessions_value, Exception): raise self.sessions_value
        return self.sessions_value

    def session(self, session_id):
        self.calls.append(("GET", "/api/v1/sessions/" + session_id))
        if self.fresh is not None: return self.fresh
        return next(s for s in self.sessions_value if s.get("id") == session_id)

    def send(self, session_id, text):
        self.calls.append(("POST", "/api/v1/sessions/%s/input" % session_id, text))
        if self.fail_send: raise RuntimeError("boom")

    def sent(self):
        return [c for c in self.calls if c[0] == "POST"]


def session(name, sid, now, status="idle", working=False, quiet_min=5, **extra):
    return dict(name=name, id=sid, status=status, isWorking=working,
                lastActivityAt=now.timestamp() * 1000 - quiet_min * MIN, **extra)


def alpha(now, **kw): return session("Alpha", "a1", now, **kw)
def beta(now, **kw): return session("Beta", "b1", now, **kw)
def other(now): return session("Other", "o1", now)


class RoutinesTests(unittest.TestCase):
    def setUp(self):
        # A per-test alarm: a hang fails that test fast instead of stalling the run (review: M5 was caught only by timeout).
        # The 864-tick cap test performs thousands of durable SQLite commits. Its
        # assertions check delivery limits, not disk throughput on a busy builder.
        timeout = 120 if self._testMethodName == "test_flood_of_ticks_never_types_more_than_the_call_caps" else 30
        def hung(signum, frame): raise TimeoutError(f"test took over {timeout} s")
        previous = signal.signal(signal.SIGALRM, hung); signal.alarm(timeout)
        self.addCleanup(lambda: (signal.alarm(0), signal.signal(signal.SIGALRM, previous)))
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.policy_path = self.root / "routines.json"
        self.write_policy()
        self.state = State(self.root / "state.sqlite")
        self.lines = []

    def write_policy(self, **changes):
        raw = {"timezone": "America/Chicago",
               "agents": {"alpha": {"session": "Alpha", "session_id": "a1", "sleep": {"start": "01:30", "end": "06:30"}},
                          "beta": {"session": "Beta", "session_id": "b1", "sleep": {"start": "02:00", "end": "05:30"}}}}
        raw.update(changes)
        self.policy_path.write_text(json.dumps(raw))
        self.policy = load_policy(self.policy_path)

    def tick(self, now, sessions, live=True, paused=False, console=None):
        console = console or FakeConsole(sessions)
        Tick(self.policy, self.state, console, self.lines.append, now, live=live, paused=paused).run()
        return console

    def codes(self):
        return [line.split()[3] + ":" + line.split()[4] for line in self.lines]

    # ---- policy ----------------------------------------------------------------------------------
    def test_policy_is_validated_strictly_and_fails_closed(self):
        ok = {"session": "Alpha", "session_id": "a1", "sleep": {"start": "01:30", "end": "06:30"}}
        bad = [{"timezone": "Mars/Base"},
               {"agents": {"Alpha": ok}},
               {"agents": {"alpha": dict(ok, session="Al;pha")}},
               {"agents": {"alpha": dict(ok, session_id=None)}},
               {"agents": {"alpha": dict(ok, session_id="../x")}},
               {"agents": {"alpha": dict(ok, sleep={"start": "1:30", "end": "06:30"})}},
               {"agents": {"alpha": dict(ok, sleep={"start": "06:30", "end": "06:30"})}},
               {"agents": {"a": ok, "b": dict(ok, session="Other")}},                      # same session_id twice
               {"agents": {"a": ok, "b": dict(ok, session_id="z9")}},                      # same name twice
               {"agents": {"alpha": dict(ok, calls="yes")}},
               {"caps": {"calls_per_day": 5}}, {"coffee": {"every_minutes": 5}}, {"calls": {"wake_after_minutes": 500}},
               {"agents": {}}]
        for change in bad:
            with self.subTest(change=change), self.assertRaises(PolicyError):
                self.write_policy(**change)
        self.policy_path.write_text("{not json")
        self.assertEqual(main(["tick", "--policy", str(self.policy_path), "--state-dir", str(self.root / "s")]), 2)
        self.assertFalse((self.root / "s").exists())                                   # refused before any state

    def test_cycle_policy_mismatch_is_reported_not_fatal(self):
        cycle = self.root / "cycle.json"
        cycle.write_text(json.dumps({"timezone": "UTC", "night": {"start": "01:00", "end": "06:00"},
                                     "agents": {"alpha": {"night_start": "01:30"}}}))
        self.write_policy(cycle_policy=str(cycle))
        now = local(2026, 10, 16, 10, 0)
        self.tick(now, [alpha(now)])
        self.assertIn("policy_mismatch:timezone", self.codes())
        self.assertIn("policy_mismatch:alpha", self.codes())                            # end 06:00 != 06:30
        for day, bad in ((1, "garbage"), (2, "x" * (70 * 1024)), (3, "[" * 20000 + "]" * 20000)):   # N1: deep nesting
            cycle.write_text(bad)
            self.lines.clear(); self.tick(now + dt.timedelta(days=day), [alpha(now)])
            self.assertIn("policy_mismatch:cycle_policy_unreadable", self.codes())

    def test_cycle_policy_fifo_symlink_and_device_never_block_or_stop_the_tick(self):
        # F3: an agent can replace the cycle policy. Whatever it is, the tick finishes and still acts.
        fifo, link = self.root / "fifo", self.root / "link"
        os.mkfifo(fifo); link.symlink_to("/dev/zero")
        for path in (fifo, link, Path("/dev/zero")):
            with self.subTest(path=str(path)):
                self.write_policy(cycle_policy=str(path))
                self.state = State(self.root / ("s-%s.sqlite" % path.name))
                self.lines.clear()
                due = local(2026, 10, 16, 1, 10)
                def blocked(signum, frame): raise TimeoutError("tick blocked on %s" % path)
                previous = signal.signal(signal.SIGALRM, blocked); signal.alarm(5)
                try:
                    console = self.tick(due, [alpha(due)])
                finally:
                    signal.alarm(0); signal.signal(signal.SIGALRM, previous)
                self.assertEqual(len(console.sent()), 1)                                  # the call still went out
                self.assertIn("policy_mismatch:cycle_policy_unreadable", self.codes())

    # ---- privacy and transport -------------------------------------------------------------------
    def test_only_session_routes_and_no_room_reads(self):
        source = Path(routines.__file__).read_text()
        self.assertNotIn("chatroom", source.lower())
        self.assertEqual(sorted(set(re.findall(r'"(/api/[^"%]*)', source))),
                         ["/api/cron/count", "/api/cron/jobs", "/api/subscription-profiles/usage", "/api/v1/sessions", "/api/v1/sessions/"])
        now = local(2026, 10, 16, 1, 10)
        console = self.tick(now, [alpha(now), beta(now, status="busy", working=True, quiet_min=90)])
        allowed = ("/api/v1/sessions", "/api/cron/", "/api/subscription-profiles/usage")
        self.assertTrue(all(c[1].startswith(allowed) for c in console.calls), console.calls)
        self.assertTrue(all(c[1].startswith("/api/v1/sessions/") for c in console.sent()))   # writes only to session input

    def test_post_body_is_untagged_and_redirects_are_refused(self):
        class Opener:
            def __init__(self, reply=b'{"success":true,"data":{}}'): self.requests, self.reply = [], reply
            def open(self, request, timeout):
                self.requests.append(request); reply = self.reply
                class R:
                    def __enter__(s): return s
                    def __exit__(s, *a): return False
                    def read(s, n): return reply
                return R()
        opener = Opener()
        console = Console("http://127.0.0.1:3001", "secret", opener)
        console.send("abc-1", TEMPLATES["wake"])
        request = opener.requests[0]
        self.assertEqual(request.full_url, "http://127.0.0.1:3001/api/v1/sessions/abc-1/input")
        self.assertEqual(json.loads(request.data), {"input": TEMPLATES["wake"] + "\r", "useMux": True})   # F2: no clientId/seq
        self.assertEqual(request.get_header("X-reverie-service-token"), "secret")
        Console("http://127.0.0.1:3001", "secret", Opener(b'{"success":true,"data":null}')).send("abc-1", "x")   # N3: accepted
        Console("http://127.0.0.1:3001", "secret", Opener(b'{}')).send("abc-1", "x")
        for reply in (b'{"success":true,"data":{"buffered":true}}', b'{"success":true,"data":{"buffered":true,"dropped":true}}',
                      b'{"success":true,"data":{"duplicate":true}}', b'{"success":false}', b'[1]'):
            with self.subTest(reply=reply), self.assertRaises(Exception):
                Console("http://127.0.0.1:3001", "secret", Opener(reply)).send("abc-1", "x")
        for url in ("http://example.com", "https://127.0.0.1:3001", "http://127.0.0.1.evil:3001"):
            with self.assertRaises(PolicyError): Console(url)
        with self.assertRaises(RuntimeError): console.send("../x", "t")
        with self.assertRaises(RuntimeError): console.session("../x")
        self.assertIsNone(routines.NoRedirect().redirect_request(None, None, 302, "Found", {}, "http://evil/"))
        default = Console("http://127.0.0.1:3001", "secret")
        self.assertTrue(any(isinstance(h, routines.NoRedirect) for h in default.opener.handlers))

    def test_templates_are_single_printable_lines_without_bang(self):
        self.assertEqual(set(TEMPLATES), {"wind_down", "wake", "retro", "retro_compile", "kickoff"})   # no nudge template
        for kind, template in TEMPLATES.items():
            text = template.format(minutes=999)
            with self.subTest(kind=kind):
                self.assertRegex(text, r"^[ -~]{1,300}$")
                self.assertNotIn("!", text)
                self.assertTrue(text.startswith("[automated - not the owner - routine "), text)   # the shared ASCII marker

    # ---- stalls and dialogs are report-only (F1) -------------------------------------------------
    def test_stalled_busy_agents_are_reported_never_typed_into(self):
        start = local(2026, 10, 16, 8, 0)
        for minutes in range(0, 14 * 60, 5):
            now = start + dt.timedelta(minutes=minutes)
            busy = alpha(now, status="busy", working=True, quiet_min=45)                    # paneDialog null while busy
            self.assertEqual(self.tick(now, [busy]).sent(), [])
        self.assertEqual(self.codes().count("stalled:alpha"), 7)                           # once per 2-h round
        now = local(2026, 10, 16, 14, 1)
        for minutes in (0, 5, 10, 15):
            console = self.tick(now + dt.timedelta(minutes=minutes), [alpha(now, paneDialog="Allow?")])
            self.assertEqual(console.sent(), [])
        self.assertIn("dialog:alpha", self.codes())
        self.assertFalse(any("Allow" in line for line in self.lines))                     # dialog text never reported

    def test_flood_of_ticks_never_types_more_than_the_call_caps(self):
        rng = random.Random(7)
        start = local(2026, 10, 16, 0, 0)
        per_day = {}
        for minutes in range(0, 3 * 1440, 5):
            now = start + dt.timedelta(minutes=minutes)
            choice = rng.choice(["busy", "idle", "dialog", "gone", "garbage", "two", "renamed", "moved"])
            sessions = {"busy": [alpha(now, status="busy", working=True, quiet_min=rng.randint(0, 120))],
                        "idle": [alpha(now, quiet_min=rng.randint(0, 5))],
                        "dialog": [alpha(now, paneDialog="permission")],
                        "gone": [other(now)],
                        "garbage": rng.choice([[], None, "x", [1, 2], {"a": 1}]),
                        "two": [alpha(now), alpha(now)],
                        "renamed": [session("Zed", "a1", now)],
                        "moved": [session("Alpha", "evil", now), other(now)]}[choice]
            for call in self.tick(now, sessions).sent():
                self.assertEqual(call[1], "/api/v1/sessions/a1/input")                     # only ever the pinned id
                key = now.astimezone(ZONE).date()
                per_day[key] = per_day.get(key, 0) + 1
        self.assertTrue(per_day)
        self.assertTrue(all(count <= 2 for count in per_day.values()), per_day)

    def test_dry_run_and_sleep_follow_the_same_rules(self):
        due = local(2026, 10, 16, 1, 10)
        self.tick(due, [alpha(due, status="busy", working=True)], live=False)               # busy: not even "would send"
        self.assertNotIn("wind_down_would_send:alpha", self.codes())
        night = local(2026, 10, 16, 3, 0)                                                   # both asleep, both silent for hours
        self.tick(night, [alpha(night, status="busy", working=True, quiet_min=200), beta(night, paneDialog="x")])
        self.tick(night + dt.timedelta(minutes=15), [alpha(night, status="busy", working=True, quiet_min=200), beta(night, paneDialog="x")])
        self.assertFalse([c for c in self.codes() if c.startswith(("stalled", "dialog"))])

    # ---- pinned identity (F5) --------------------------------------------------------------------
    def test_a_session_renamed_to_the_agent_never_becomes_the_target(self):
        due = local(2026, 10, 16, 1, 10)
        console = self.tick(due, [session("Alpha", "evil", due), alpha(due, status="stopped")])
        self.assertEqual(console.sent(), [])
        self.assertIn("moved:alpha", self.codes())
        self.assertEqual(self.tick(due + dt.timedelta(minutes=5), [session("Not Alpha", "a1", due)]).sent(), [])
        self.assertIn("renamed:alpha", self.codes())
        self.state = State(self.root / "clean.sqlite")
        console = self.tick(due, [alpha(due), session("Alpha", "evil", due)])            # an impostor alongside
        self.assertEqual([c[1] for c in console.sent()], ["/api/v1/sessions/a1/input"])

    # ---- calls -----------------------------------------------------------------------------------
    def test_wind_down_and_wake_calls(self):
        # Alpha sleeps 01:30-06:30: wind-down due 01:10; wake due 06:45 (15 min after), only into a quiet idle prompt.
        texts = []
        for hhmm in ("01:05", "01:10", "01:15"):
            now = local(2026, 10, 16, int(hhmm[:2]), int(hhmm[3:]))
            texts += [c[2] for c in self.tick(now, [alpha(now)]).sent()]
        self.assertEqual(texts, [TEMPLATES["wind_down"].format(minutes=20)])
        at_end = local(2026, 10, 16, 6, 30)
        self.assertEqual(self.tick(at_end, [alpha(at_end)]).sent(), [])                     # F8: not before wake_after
        busy = local(2026, 10, 16, 6, 45)
        self.assertEqual(self.tick(busy, [alpha(busy, status="busy", working=True)]).sent(), [])
        fresh = local(2026, 10, 16, 6, 50)
        self.assertEqual(self.tick(fresh, [alpha(fresh, quiet_min=0)]).sent(), [])         # active < 60 s ago
        unknown_activity = local(2026, 10, 16, 6, 55)
        no_time = alpha(unknown_activity); del no_time["lastActivityAt"]
        self.assertEqual(self.tick(unknown_activity, [no_time]).sent(), [])                # missing time = not callable
        idle = local(2026, 10, 16, 7, 0)
        self.assertEqual([c[2] for c in self.tick(idle, [alpha(idle)]).sent()], [TEMPLATES["wake"]])
        later = local(2026, 10, 16, 7, 5)
        self.assertEqual(self.tick(later, [alpha(later)]).sent(), [])

    def test_recheck_before_send_defers_without_typing_and_retries_later(self):
        # F4: the single-session re-check just before the POST. A failed re-check types nothing and
        # leaves the slot open for the next tick inside the window.
        due = local(2026, 10, 16, 1, 10)
        cases = (dict(alpha(due), status="busy"), dict(alpha(due), paneDialog="Allow?"), dict(alpha(due), name="Zed"),
                 dict(alpha(due), id="evil"), alpha(due, quiet_min=0), {"oops": 1}, "not-a-dict")
        for number, fresh in enumerate(cases):
            with self.subTest(fresh=fresh):
                self.state = State(self.root / ("r-%d.sqlite" % number))
                console = FakeConsole([alpha(due)], fresh=fresh)
                self.tick(due, None, console=console)
                self.assertEqual(console.sent(), [])
                self.assertIn(("GET", "/api/v1/sessions/a1"), console.calls)
                retry = due + dt.timedelta(minutes=5)
                self.assertEqual(len(self.tick(retry, [alpha(retry)]).sent()), 1)

    def test_missed_calls_are_recorded_once_and_never_replayed_late(self):
        first = local(2026, 10, 15, 12, 0)
        self.tick(first, [alpha(first)])                                                     # the ledger's first tick
        late = local(2026, 10, 16, 9, 0)                                                     # timer down 00:00-09:00
        console = self.tick(late, [alpha(late)])
        self.assertEqual(console.sent(), [])
        self.assertIn("wind_down_missed:alpha", self.codes())
        self.assertIn("wake_missed:alpha", self.codes())
        self.lines.clear()
        self.tick(late + dt.timedelta(minutes=5), [alpha(late)])
        self.assertNotIn("wake_missed:alpha", self.codes())

    def test_first_run_does_not_report_slots_from_before_it(self):
        late = local(2026, 10, 16, 9, 0)
        self.tick(late, [alpha(late)])
        self.assertNotIn("wake_missed:alpha", self.codes())
        self.assertNotIn("wind_down_missed:alpha", self.codes())
        self.assertTrue(self.state.has("wake", "alpha", "wake@2026-10-16"))                # still recorded

    def test_wind_down_is_not_sent_once_the_agent_is_asleep(self):
        busy = local(2026, 10, 16, 1, 10)
        self.tick(busy, [alpha(busy, status="busy", working=True)])
        asleep = local(2026, 10, 16, 1, 35)
        self.assertEqual(self.tick(asleep, [alpha(asleep)]).sent(), [])
        self.tick(local(2026, 10, 16, 1, 45), [alpha(asleep)])
        self.assertIn("wind_down_missed:alpha", self.codes())

    def test_dst_fall_back_wakes_once(self):
        # 2026-11-01 01:00-02:00 repeats in Chicago; Beta's window 02:00-05:30 wakes once.
        sent = []
        start = dt.datetime(2026, 11, 1, 4, 0, tzinfo=dt.timezone.utc)                    # 23:00 CDT on Oct 31
        for minutes in range(0, 9 * 60, 5):
            now = start + dt.timedelta(minutes=minutes)
            sent += [c[2] for c in self.tick(now, [beta(now)]).sent()]
        self.assertEqual(sent.count(TEMPLATES["wake"]), 1)

    def test_calls_per_day_cap(self):
        self.write_policy(caps={"calls_per_day": 1})
        due = local(2026, 10, 16, 1, 10)
        self.assertEqual(len(self.tick(due, [alpha(due)]).sent()), 1)
        wake = local(2026, 10, 16, 6, 50)
        self.assertEqual(self.tick(wake, [alpha(wake)]).sent(), [])
        self.assertIn("cap_reached:alpha", self.codes())

    def test_dry_run_paused_no_token_and_send_failure(self):
        due = local(2026, 10, 16, 1, 10)
        self.assertEqual(self.tick(due, [alpha(due)], live=False).sent(), [])
        self.assertIn("wind_down_would_send:alpha", self.codes())
        self.assertTrue(all(line.endswith("dry-run") for line in self.lines))
        self.state = State(self.root / "other.sqlite")
        self.assertEqual(self.tick(due, [alpha(due)], paused=True).sent(), [])
        self.state = State(self.root / "third.sqlite")
        console = FakeConsole([alpha(due)]); console.token = None
        self.assertEqual(self.tick(due, None, console=console).sent(), [])
        self.assertIn("no_token:alpha", self.codes())
        self.state = State(self.root / "fourth.sqlite")
        console = FakeConsole([alpha(due)]); console.fail_send = True
        self.tick(due, None, console=console)
        self.assertEqual(len(console.sent()), 1)
        self.assertEqual(self.tick(due + dt.timedelta(minutes=5), [alpha(due)]).sent(), [])   # a failed send is not retried
        self.assertEqual(self.state.count(("wind_down",), "alpha", "2026-10-16"), 1)

    def test_ledger_row_is_written_before_the_send(self):
        due = local(2026, 10, 16, 1, 10)
        seen = []
        class Watching(FakeConsole):
            def send(inner, sid, text):
                seen.append(self.state.db.execute("select status from sends where kind='wind_down'").fetchone())
                super().send(sid, text)
        self.tick(due, None, console=Watching([alpha(due)]))
        self.assertEqual(seen, [("pending",)])

    def test_state_dir_that_is_a_file_exits_3(self):
        not_a_dir = self.root / "statefile"; not_a_dir.write_text("x")
        self.assertEqual(main(["tick", "--policy", str(self.policy_path), "--state-dir", str(not_a_dir)], out=io.StringIO()), 3)

    def test_corrupt_state_fails_closed(self):
        state_dir = self.root / "corrupt"; state_dir.mkdir()
        (state_dir / "routines.sqlite").write_bytes(b"this is not a database" * 100)
        class Opener:
            def open(s, request, timeout): raise AssertionError("no request may be made")
        out = io.StringIO()
        code = main(["tick", "--live", "--policy", str(self.policy_path), "--state-dir", str(state_dir)], out=out, opener=Opener())
        self.assertEqual(code, 3)
        self.assertEqual(out.getvalue(), "")

    # ---- retro, kickoff, generic sleep guard, quota, cron count -----------------------------------
    def routines_policy(self, **extra):
        agents = {"alpha": {"session": "Alpha", "session_id": "a1", "sleep": {"start": "01:30", "end": "06:30"}, "lead": True},
                  "beta": {"session": "Beta", "session_id": "b1", "sleep": {"start": "02:00", "end": "05:30"}, "lead": True},
                  "boss": {"session": "Boss", "session_id": "c1", "sleep": {"start": "00:30", "end": "06:00"}}}
        routines = {"retro": {"at": "20:00", "compiler": "boss"}, "kickoff": {"at": "09:00", "to": "boss"}}
        routines.update(extra.pop("routines", {}))
        extra.setdefault("quota", {"profile": "p1", "reserve_percent": 15})
        self.write_policy(agents=agents, routines=routines, **extra)
        if not getattr(self, "real_quota", False):
            patcher = mock.patch.object(routines_module, "plan_open", return_value=True)
            patcher.start(); self.addCleanup(patcher.stop)

    def everyone(self, now, **kw):
        return [alpha(now, **kw), beta(now, **kw), session("Boss", "c1", now, **kw)]

    def test_retro_staggered_compile_and_kickoff(self):
        self.routines_policy()
        sent = {}
        start = local(2026, 10, 16, 19, 55)                                       # a Friday
        for minutes in range(0, 60, 5):
            now = start + dt.timedelta(minutes=minutes)
            for call in self.tick(now, self.everyone(now)).sent():
                sent.setdefault(call[1].split("/")[4], []).append((now.astimezone(ZONE).strftime("%H:%M"), call[2]))
        self.assertEqual([t for t, _ in sent["a1"]], ["20:00"])                   # first lead at 20:00
        self.assertEqual([t for t, _ in sent["b1"]], ["20:05"])                   # second lead staggered 3 min -> next tick
        self.assertEqual([t for t, _ in sent["c1"]], ["20:45"])                   # the compiler at +45
        self.assertTrue(sent["a1"][0][1].startswith("[automated - not the owner - routine retro]"))
        self.assertTrue(sent["c1"][0][1].startswith("[automated - not the owner - routine retro-compile]"))
        morning = local(2026, 10, 17, 9, 0)
        texts = [c[2] for c in self.tick(morning, self.everyone(morning)).sent()]
        self.assertEqual(texts, [TEMPLATES["kickoff"]])

    def test_weekdays_only(self):
        self.routines_policy(routines={"weekdays_only": True})
        saturday = local(2026, 10, 17, 20, 0)
        self.assertEqual(self.tick(saturday, self.everyone(saturday)).sent(), [])
        monday = local(2026, 10, 19, 20, 0)
        self.assertEqual(len(self.tick(monday, self.everyone(monday)).sent()), 1)

    def test_one_generic_sleep_guard_for_every_kind(self):
        # A routine whose window reaches into an agent's sleep is never sent once it sleeps, whatever the kind.
        self.routines_policy(routines={"kickoff": {"at": "09:00", "to": "boss", "valid_minutes": 180}})
        with mock.patch.object(routines, "asleep", return_value=True):
            now = local(2026, 10, 16, 9, 0)
            self.assertEqual(self.tick(now, self.everyone(now)).sent(), [])
        later = local(2026, 10, 16, 9, 5)
        self.assertEqual([c[2] for c in self.tick(later, self.everyone(later)).sent()], [TEMPLATES["kickoff"]])

    def test_routine_times_are_validated_against_sleep_windows_at_load(self):
        for routines_value in ({"kickoff": {"at": "06:40", "to": "boss"}},            # 06:00 + 15 + 30 margin
                               {"retro": {"at": "00:50", "compiler": "boss"}},          # alpha's wind-down is 01:10
                               {"retro": {"at": "20:00", "compiler": "nobody"}},
                               {"retro": {"at": "20:00", "compiler": "boss", "compile_after_minutes": 5}},
                               {"stagger_minutes": 99}):
            with self.subTest(routines=routines_value), self.assertRaises(PolicyError):
                self.routines_policy(routines=routines_value)
        with self.assertRaises(PolicyError):
            self.write_policy(routines={"retro": {"at": "20:00", "compiler": "alpha"}})  # no lead: true agents

    def test_routines_have_their_own_counter(self):
        self.routines_policy(caps={"calls_per_day": 0, "routines_per_day": 1})   # calls off: routines must still go
        start = local(2026, 10, 16, 19, 55)
        sent = 0
        for minutes in range(0, 60, 5):
            now = start + dt.timedelta(minutes=minutes)
            sent += len([c for c in self.tick(now, self.everyone(now)).sent() if c[1].endswith("/c1/input")])
        self.assertEqual(sent, 1)                                                  # compile counts against routines_per_day only
        self.assertEqual(self.state.count(("retro_compile",), "boss", "2026-10-16"), 1)

    def test_quota_gate_fails_closed(self):
        self.real_quota = True
        now = local(2026, 10, 16, 9, 0)
        stamp = now.timestamp() * 1000
        def plan(used, age_s=10, status="ready"):
            return {"accounts": [{"id": "p1", "status": status, "updatedAt": stamp - age_s * 1000,
                                  "usage": {"fiveHour": {"usedPercentage": used, "resetAt": stamp + 3600_000}}}]}
        past = {"accounts": [{"id": "p1", "status": "ready", "updatedAt": stamp - 10_000,
                              "usage": {"fiveHour": {"usedPercentage": 40, "resetAt": stamp - 60_000}}}]}
        for value, expect in ((plan(40), 1), (plan(90), 0), (plan(40, age_s=5000), 0), (plan(40, status="x"), 0),
                              (plan(float("nan")), 0), (plan(float("inf")), 0), (past, 0),
                              ({"accounts": []}, 0), (RuntimeError("503"), 0), ({"nope": 1}, 0)):
            with self.subTest(value=value):
                self.routines_policy(quota={"profile": "p1", "reserve_percent": 15})
                self.state = State(self.root / ("q%d.sqlite" % random.randrange(10**9)))
                console = FakeConsole(self.everyone(now), plan=value)
                self.tick(now, None, console=console)
                self.assertEqual(len(console.sent()), expect)
        self.assertIn("kickoff_deferred_quota:boss", self.codes())
        with self.assertRaises(PolicyError):
            self.write_policy(quota={"profile": "bad id!"})
        with self.assertRaises(PolicyError):                                         # routines without a quota section
            self.routines_policy(quota=None)

    def test_a_closed_quota_defers_and_a_later_open_tick_still_sends(self):
        self.real_quota = True
        self.routines_policy()
        now = local(2026, 10, 16, 9, 0)
        open_reading = lambda t: {"accounts": [{"id": "p1", "status": "ready", "updatedAt": t.timestamp() * 1000,
                                                "usage": {"fiveHour": {"usedPercentage": 10, "resetAt": t.timestamp() * 1000 + 3600_000}}}]}
        self.assertEqual(self.tick(now, None, console=FakeConsole(self.everyone(now), plan=RuntimeError("503"))).sent(), [])
        later = now + dt.timedelta(minutes=30)
        sent = self.tick(later, None, console=FakeConsole(self.everyone(later), plan=open_reading(later))).sent()
        self.assertEqual([c[2] for c in sent], [TEMPLATES["kickoff"]])

    def test_zero_stagger_sends_all_leads_together(self):
        self.routines_policy(routines={"stagger_minutes": 0})
        now = local(2026, 10, 16, 20, 0)
        targets = sorted(c[1].split("/")[4] for c in self.tick(now, self.everyone(now)).sent())
        self.assertEqual(targets, ["a1", "b1"])

    def test_a_compiler_who_is_a_lead_gets_only_the_compile_line(self):
        self.routines_policy(routines={"retro": {"at": "20:00", "compiler": "alpha"}})
        start = local(2026, 10, 16, 19, 55)
        alpha_texts = []
        for minutes in range(0, 60, 5):
            now = start + dt.timedelta(minutes=minutes)
            alpha_texts += [c[2] for c in self.tick(now, self.everyone(now)).sent() if c[1].endswith("/a1/input")]
        self.assertEqual(alpha_texts, [TEMPLATES["retro_compile"]])
        self.assertIn("your own", TEMPLATES["retro_compile"])
        self.assertIn("attributed to its lead", TEMPLATES["retro_compile"])
        self.assertIn("unverified", TEMPLATES["retro_compile"])

    def test_cron_count_route_with_list_fallback_and_refusal(self):
        import urllib.error
        class Opener:
            def __init__(self, replies): self.replies, self.urls = replies, []
            def open(self, request, timeout):
                self.urls.append(request.full_url)
                reply = self.replies[request.full_url.rsplit("/api", 1)[1]]
                if isinstance(reply, int):
                    raise urllib.error.HTTPError(request.full_url, reply, "x", {}, None)
                class R:
                    def __enter__(r): return r
                    def __exit__(r, *a): return False
                    def read(r, n): return json.dumps(reply).encode()
                return R()
        count = Console("http://127.0.0.1:3001", "t", Opener({"/cron/count": {"success": True, "data": {"count": 4}}})).cron_jobs()
        self.assertEqual(count, 4)
        fallback = Opener({"/cron/count": 404, "/cron/jobs": [{"promptText": "secret"}, {}]})
        self.assertEqual(Console("http://127.0.0.1:3001", "t", fallback).cron_jobs(), 2)
        with self.assertRaises(urllib.error.HTTPError):
            Console("http://127.0.0.1:3001", "t", Opener({"/cron/count": 403})).cron_jobs()   # enforce: refused, not counted
        with self.assertRaises(RuntimeError):
            Console("http://127.0.0.1:3001", "t", Opener({"/cron/count": {"count": -1}})).cron_jobs()

    def test_cron_count_reports_counts_only(self):
        now = local(2026, 10, 16, 14, 0)
        self.tick(now, [alpha(now)], console=FakeConsole([alpha(now)], cron=0))
        self.assertFalse([c for c in self.codes() if c.startswith("cron")])
        self.tick(now + dt.timedelta(minutes=5), None, console=FakeConsole([alpha(now)], cron=2))
        self.assertIn("cron_jobs_grew:-", self.codes())
        self.lines.clear()
        self.tick(now + dt.timedelta(minutes=10), None, console=FakeConsole([alpha(now)], cron=2))
        self.assertEqual([c for c in self.codes() if c.startswith("cron")], ["cron_jobs:-"])   # once a day
        self.tick(now + dt.timedelta(minutes=15), None, console=FakeConsole([alpha(now)], cron=2))
        self.assertEqual([c for c in self.codes() if c.startswith("cron")], ["cron_jobs:-"])
        self.tick(now + dt.timedelta(minutes=20), None, console=FakeConsole([alpha(now)], cron=RuntimeError("401")))
        self.assertIn("cron_unknown:-", self.codes())
        source = Path(routines.__file__).read_text()
        self.assertNotIn("promptText", source)                                      # job text is never read

    # ---- down detection --------------------------------------------------------------------------
    def test_down_needs_two_observations_and_unknown_never_counts(self):
        t0 = local(2026, 10, 16, 14, 2)
        self.tick(t0, [other(t0)])
        self.tick(t0 + dt.timedelta(minutes=2), [other(t0)])                               # too soon to confirm
        self.assertNotIn("down:alpha", self.codes())
        console = self.tick(t0 + dt.timedelta(minutes=5), [other(t0)])
        self.assertEqual(self.codes().count("down:alpha"), 1)
        self.assertEqual(console.sent(), [])                                                # R1 never restarts
        self.tick(t0 + dt.timedelta(minutes=10), [other(t0)])
        self.assertEqual(self.codes().count("down:alpha"), 1)                              # once per episode
        back = t0 + dt.timedelta(minutes=15)
        self.tick(back, [alpha(back)])
        self.assertIn("recovered:alpha", self.codes())
        self.tick(back + dt.timedelta(minutes=5), [alpha(back), alpha(back)])
        self.assertIn("unknown:alpha", self.codes())
        self.tick(back + dt.timedelta(minutes=10), [alpha(back, status="stopped"), other(back)])
        self.tick(back + dt.timedelta(minutes=15), [alpha(back, paneExit={"status": 1}), other(back)])
        self.assertEqual(self.codes().count("down:alpha"), 2)

    def test_unknown_and_long_gaps_reset_the_down_streak(self):
        # F6: down, then unknown (or nothing for hours), then down again is a new first observation.
        t0 = local(2026, 10, 16, 14, 2)
        self.tick(t0, [other(t0)])
        self.tick(t0 + dt.timedelta(minutes=3), RuntimeError("503"))
        self.tick(t0 + dt.timedelta(minutes=6), [other(t0)])
        self.assertNotIn("down:alpha", self.codes())
        self.tick(t0 + dt.timedelta(minutes=9), [alpha(t0), alpha(t0)])                     # agent-level unknown
        self.tick(t0 + dt.timedelta(minutes=12), [other(t0)])
        self.assertNotIn("down:alpha", self.codes())
        self.tick(t0 + dt.timedelta(hours=6), [other(t0)])                                 # a 6-h gap
        self.assertNotIn("down:alpha", self.codes())
        self.tick(t0 + dt.timedelta(hours=6, minutes=5), [other(t0)])
        self.assertIn("down:alpha", self.codes())

    def test_down_needs_two_spaced_observations_not_just_time(self):
        t0 = local(2026, 10, 16, 14, 2)
        for seconds in range(0, 300, 50):
            self.tick(t0 + dt.timedelta(seconds=seconds), [other(t0)])
        self.assertNotIn("down:alpha", self.codes())

    def test_empty_or_malformed_lists_are_unknown_never_down(self):
        now = local(2026, 10, 16, 14, 2)
        for value in ([], [1], "x"):
            self.assertEqual(routines.observe(value, self.policy["agents"]["alpha"], now)[0], "unknown")
        self.tick(now, [])
        self.assertEqual(self.codes(), ["console_unknown:-"])

    def test_reports_carry_codes_only(self):
        now = local(2026, 10, 16, 14, 1)
        self.tick(now, [beta(now, status="busy", working=True, quiet_min=90, paneDialog="secret text")])
        self.tick(now, [alpha(now, status="busy", working=True, quiet_min=45), session("Alpha", "evil", now)])
        self.assertTrue(self.lines)
        for line in self.lines:
            self.assertRegex(line, r"^routines-report v1 \S+ [a-z_]+ [a-z0-9_-]+ \d+( dry-run)?$")

    def test_cli_status_and_check_policy(self):
        out = io.StringIO()
        self.assertEqual(main(["check-policy", "--policy", str(self.policy_path)], out=out), 0)
        self.assertIn("2 agents", out.getvalue())
        out = io.StringIO()
        state_dir = self.root / "cli"
        now = local(2026, 10, 16, 1, 10)
        class Opener:
            def open(s, request, timeout):
                assert request.full_url.endswith("/api/v1/sessions") and request.get_method() == "GET"
                class R:
                    def __enter__(r): return r
                    def __exit__(r, *a): return False
                    def read(r, n): return json.dumps({"success": True, "data": [alpha(now)]}).encode()
                return R()
        self.assertEqual(main(["tick", "--policy", str(self.policy_path), "--state-dir", str(state_dir)], now=now, opener=Opener(), out=out), 0)
        self.assertIn("wind_down_would_send alpha", out.getvalue())
        self.assertTrue((state_dir / "routines.dry.sqlite").exists())
        self.assertFalse((state_dir / "routines.sqlite").exists())
        out = io.StringIO()
        main(["status", "--policy", str(self.policy_path), "--state-dir", str(state_dir)], now=now, out=out)
        status = json.loads(out.getvalue())
        self.assertEqual((status["ledger"], status["heartbeat"]), ("dry", now.timestamp()))


if __name__ == "__main__": unittest.main()
