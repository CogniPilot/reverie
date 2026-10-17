"""Scheduled routines, R1: status rounds and wake-up/wind-down calls, run ON THE HOST.

    fleet-routines tick [--live]        # one 5-minute timer tick (dry run unless --live)
    fleet-routines check-policy         # validate the host policy and exit
    fleet-routines status [--live]      # heartbeat, open episodes, today's sends (dry ledger unless --live)

Design: reports/routines-and-collective-memory-design-v2.md (R1 scope), its delta review, and
review-routines-r1.md (F1-F9).
The trust rule: everything that decides whether to act is host-held. The policy is an owner-written
host file, and the ledger and observations are a host SQLite file. No container command is run.
Console routes used:
  GET  /api/v1/sessions             (one list per tick)
  GET  /api/v1/sessions/<id>        (a re-check just before each send)
  POST /api/v1/sessions/<id>/input  (fixed one-line templates)
- It never reads chat rooms: the room list carries each room's last message.
- Reports go to a host file and the journal, never to a room, so nothing is ever posted as the
  user.
- R1 sends NO nudges (F1). A busy pane with no output may be a permission dialog that the console
  has not flagged; Enter would answer it. Stalls are reported only.
- The one agent-writable input, the optional night-cycle policy, is read last. Its read is
  non-blocking and capped, and a failure only adds a report (F3).

Standard library only, so the host can run it from a verified build or a bare python3 -I.
"""
from __future__ import annotations
import argparse
import datetime as dt
import json
import math
import os
import re
import sqlite3
import stat
import sys
import urllib.error
import urllib.request
from pathlib import Path
from zoneinfo import ZoneInfo

AGENT = re.compile(r"[a-z][a-z0-9_-]{0,31}")
SESSION_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}")
SESSION_ID = re.compile(r"[A-Za-z0-9_-]{1,80}")
HHMM = re.compile(r"([01][0-9]|2[0-3]):([0-5][0-9])")
DEFAULT_URL = "http://127.0.0.1:3001"
DOWN_OBSERVATIONS = 2              # two observations from the 5-minute ticks
DOWN_MIN_SPAN = 240                # seconds between the first and the confirming observation
DOWN_MAX_GAP = 900                 # F6: an observation more than 3 ticks after the previous one starts over
WIND_DOWN_VALID = 30 * 60          # a wind-down call is still useful this long after it was due
QUIET_BEFORE_CALL = 60             # F1/F4: seconds without pane activity before a call (beyond one 30 s dialog scan)
CYCLE_POLICY_MAX = 64 * 1024

# Fixed texts. Each is one printable ASCII line with no "!" (typed delivery would flip OpenCode into shell
# mode), starting with the fleet's shared marker. The marker is unauthenticated (anyone can type it): it
# only ever lowers trust and never proves who sent a line. The only inserted values are host-computed
# integers. tests/test_routines.py checks all of them.
MARKER = "[automated - not the owner - routine %s]"
TEMPLATES = {
    "wind_down": MARKER % "wind-down" + " Your sleep window starts in {minutes} min. "
                 "Park the current task, save a handoff, and start no new long jobs.",
    "wake": MARKER % "wake" + " Good morning. Read your handoff and your unread rooms, then post your status in your room.",
    "retro": MARKER % "retro" + " Daily retro, max 10 lines in one message to your coordinator in your room: "
             "(1) went well, (2) went poorly, including your own mistakes, (3) concrete improvements for tomorrow.",
    "retro_compile": MARKER % "retro-compile" + " Compile today's retro replies and your own into one summary for "
                     "the owner, max 15 lines, each point attributed to its lead and labelled unverified (self-reports). "
                     "Post it to the owner's room; name leads who did not reply.",
    "kickoff": MARKER % "kickoff" + " Morning kickoff: list the carry-overs from yesterday's handoffs and retro, "
               "then today's top 3, and post it to the owner's room.",
}
CALL_KINDS = ("wind_down", "wake")
ROUTINE_KINDS = ("retro", "retro_compile", "kickoff")
WINDOW_MARGIN = 30          # minutes a retro/kickoff must keep from any addressed agent's wind-down and wake


class PolicyError(ValueError):
    pass


def hhmm(value, where):
    match = HHMM.fullmatch(str(value))
    if not match: raise PolicyError("%s must be HH:MM" % where)
    return dt.time(int(match.group(1)), int(match.group(2)))


def bounded(section, key, default, low, high):
    value = section.get(key, default)
    if not isinstance(value, int) or isinstance(value, bool) or not low <= value <= high:
        raise PolicyError("%s must be an integer from %d to %d" % (key, low, high))
    return value


def load_policy(path):
    """The owner's host policy, validated strictly. Any error refuses the whole tick (fail closed)."""
    try:
        raw = json.loads(Path(path).read_text())
    except (OSError, ValueError) as error:
        raise PolicyError("cannot read policy %s: %s" % (path, error))
    if not isinstance(raw, dict): raise PolicyError("policy must be an object")
    try: zone = ZoneInfo(raw.get("timezone", ""))
    except Exception: raise PolicyError("timezone must be an IANA zone name")
    coffee, calls, caps = (raw.get(k, {}) for k in ("coffee", "calls", "caps"))
    if not all(isinstance(s, dict) for s in (coffee, calls, caps)): raise PolicyError("coffee, calls and caps must be objects")
    policy = {
        "timezone": raw["timezone"], "zone": zone,
        "every": bounded(coffee, "every_minutes", 120, 30, 720),
        "stall_minutes": bounded(coffee, "stall_minutes", 30, 10, 240),
        "dialog_minutes": bounded(coffee, "dialog_minutes", 10, 5, 240),
        "wind_down_before": bounded(calls, "wind_down_minutes_before", 20, 5, 120),
        "wake_after": bounded(calls, "wake_after_minutes", 15, 0, 120),
        "wake_retry": bounded(calls, "wake_retry_minutes", 60, 5, 240),
        "calls_per_day": bounded(caps, "calls_per_day", 2, 0, 2),
        "routines_per_day": bounded(caps, "routines_per_day", 3, 0, 3),
        "cycle_policy": raw.get("cycle_policy"),
        "agents": {},
    }
    agents = raw.get("agents")
    if not isinstance(agents, dict) or not agents or len(agents) > 32: raise PolicyError("agents must name 1-32 agents")
    names, ids = set(), set()
    for name, entry in agents.items():
        if not AGENT.fullmatch(name) or not isinstance(entry, dict): raise PolicyError("bad agent entry %r" % name)
        session, session_id = entry.get("session"), entry.get("session_id")
        if not isinstance(session, str) or not SESSION_NAME.fullmatch(session): raise PolicyError("%s: session must be a plain session name" % name)
        # F5: the target is the persistent session id; the name is only cross-checked.
        if not isinstance(session_id, str) or not SESSION_ID.fullmatch(session_id): raise PolicyError("%s: session_id must be the session's id" % name)
        if session in names or session_id in ids: raise PolicyError("%s: session or session_id used twice" % name)
        names.add(session); ids.add(session_id)
        sleep = entry.get("sleep")
        if not isinstance(sleep, dict): raise PolicyError("%s: sleep needs start and end" % name)
        start, end = hhmm(sleep.get("start"), name + ".sleep.start"), hhmm(sleep.get("end"), name + ".sleep.end")
        if start == end: raise PolicyError("%s: sleep start and end must differ" % name)
        calls_on, lead = entry.get("calls", True), entry.get("lead", False)
        if not isinstance(calls_on, bool) or not isinstance(lead, bool): raise PolicyError("%s: calls and lead must be true/false" % name)
        policy["agents"][name] = dict(session=session, session_id=session_id, start=start, end=end, calls=calls_on, lead=lead)
    if policy["cycle_policy"] is not None and not isinstance(policy["cycle_policy"], str):
        raise PolicyError("cycle_policy must be a host path")
    policy["routines"] = load_routines(raw.get("routines"), policy)
    policy["quota"] = load_quota(raw.get("quota"))
    if policy["routines"] and (policy["routines"].get("retro") or policy["routines"].get("kickoff")) and not policy["quota"]:
        raise PolicyError("routines need a quota section (a retro or kickoff with no plan gate would run ungated)")
    return policy


def minute_of(t):
    return t.hour * 60 + t.minute


def load_routines(raw, policy):
    """The retro and kickoff routines (owner-set text in code; times, recipients and leads here). Every send
    time must stay WINDOW_MARGIN minutes clear of each addressed agent's wind-down and wake calls, so a
    routine never lands in or near a sleep window (checked here, for every lead's staggered time)."""
    if raw is None: return None
    if not isinstance(raw, dict): raise PolicyError("routines must be an object")
    out = {"stagger": bounded(raw, "stagger_minutes", 3, 0, 15), "weekdays_only": raw.get("weekdays_only", False)}
    if not isinstance(out["weekdays_only"], bool): raise PolicyError("routines.weekdays_only must be true/false")
    agents = policy["agents"]
    leads = [n for n, a in agents.items() if a["lead"]]
    def who(section, key):
        value = section.get(key)
        if value not in agents: raise PolicyError("routines: %s must name a policy agent" % key)
        return value
    retro, kickoff = raw.get("retro"), raw.get("kickoff")
    if retro is not None:
        if not isinstance(retro, dict) or not leads: raise PolicyError("routines.retro needs an object and at least one lead: true agent")
        out["retro"] = {"at": hhmm(retro.get("at"), "retro.at"), "compiler": who(retro, "compiler"),
                        "compile_after": bounded(retro, "compile_after_minutes", 45, 15, 120),
                        "valid": bounded(retro, "valid_minutes", 90, 15, 180), "leads": leads}
    if kickoff is not None:
        if not isinstance(kickoff, dict): raise PolicyError("routines.kickoff must be an object")
        out["kickoff"] = {"at": hhmm(kickoff.get("at"), "kickoff.at"), "to": who(kickoff, "to"),
                          "valid": bounded(kickoff, "valid_minutes", 120, 15, 180)}
    for name, minute in routine_times(out):
        agent = agents[name]
        quiet_from = (minute_of(agent["start"]) - policy["wind_down_before"] - WINDOW_MARGIN) % 1440
        quiet_to = (minute_of(agent["end"]) + policy["wake_after"] + WINDOW_MARGIN) % 1440
        inside = quiet_from <= minute < quiet_to if quiet_from < quiet_to else (minute >= quiet_from or minute < quiet_to)
        if inside:
            raise PolicyError("routines: a send to %s at %02d:%02d falls in or near its sleep window" % (name, minute // 60, minute % 60))
    return out


def routine_times(routines):
    """(agent, minute of day) for every routine send, staggered leads included."""
    times = []
    if routines.get("retro"):
        r = routines["retro"]
        for i, lead in enumerate(r["leads"]):
            times.append((lead, (minute_of(r["at"]) + i * routines["stagger"]) % 1440))
        times.append((r["compiler"], (minute_of(r["at"]) + r["compile_after"]) % 1440))
    if routines.get("kickoff"):
        times.append((routines["kickoff"]["to"], minute_of(routines["kickoff"]["at"])))
    return times


def load_quota(raw):
    if raw is None: return None
    if not isinstance(raw, dict) or not isinstance(raw.get("profile"), str) or not re.fullmatch(r"[A-Za-z0-9_.:-]{1,80}", raw["profile"]):
        raise PolicyError("quota needs a plan profile id")
    return {"profile": raw["profile"], "reserve": bounded(raw, "reserve_percent", 15, 0, 50),
            "max_age": bounded(raw, "max_age_seconds", 600, 60, 3600)}


def plan_open(value, quota, now):
    """True when the plan profile is readable, fresh and below 100 - reserve in every window. Anything
    else is False: the quota gate fails closed (skip the routine), never open."""
    try:
        accounts = value.get("accounts") if isinstance(value, dict) else None
        reading = next(a for a in accounts if isinstance(a, dict) and a.get("id") == quota["profile"])
        updated = reading.get("updatedAt")
        if (reading.get("status") != "ready" or not isinstance(updated, (int, float)) or isinstance(updated, bool)
                or not math.isfinite(updated) or not 0 <= now.timestamp() - updated / 1000 <= quota["max_age"]):
            return False
        windows = [reading["usage"].get(k) for k in ("fiveHour", "sevenDay") if reading["usage"].get(k) is not None]
        if not windows: return False
        for w in windows:
            used, reset = w.get("usedPercentage"), w.get("resetAt")
            if any(not isinstance(v, (int, float)) or isinstance(v, bool) or not math.isfinite(v) for v in (used, reset)):
                return False
            if reset / 1000 <= now.timestamp() or used >= 100 - quota["reserve"]: return False
        return True
    except (StopIteration, TypeError, AttributeError, KeyError):
        return False


def read_capped(path, limit=CYCLE_POLICY_MAX):
    """Read an agent-writable file without following links, blocking or reading without bound (F3)."""
    info = os.lstat(path)
    if not stat.S_ISREG(info.st_mode) or info.st_size > limit: raise OSError("not a small regular file")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode): raise OSError("not a regular file")
        data = os.read(fd, limit + 1)
    finally:
        os.close(fd)
    if len(data) > limit: raise OSError("too large")
    return data.decode()


def cycle_mismatches(policy):
    """Differences from the night cycle's policy. A mismatch is reported and the host policy still rules,
    because a file agents can edit must never be able to switch routines off."""
    path = policy["cycle_policy"]
    if not path: return []
    try:
        cycle = json.loads(read_capped(path))
        night, agents = cycle.get("night"), cycle.get("agents", {})
    except Exception:          # N1: any failure (deeply nested JSON raises RecursionError) is report-only
        return ["cycle_policy_unreadable"]
    if not isinstance(night, dict) or not isinstance(agents, dict): return []
    found = []
    if cycle.get("timezone") != policy["timezone"]: found.append("timezone")
    for name, agent in policy["agents"].items():
        if name not in agents or not isinstance(agents[name], dict): continue
        start = agents[name].get("night_start", night.get("start"))
        if start != agent["start"].strftime("%H:%M") or night.get("end") != agent["end"].strftime("%H:%M"):
            found.append(name)
    return found


# ---- host state ----------------------------------------------------------------------------------

SCHEMA = """
create table if not exists sends(kind text not null, agent text not null, slot text not null, day text not null,
    ts real not null, status text not null, primary key(kind, agent, slot));
create table if not exists obs(agent text primary key, down_since real, down_last real, down_count integer not null default 0,
    down_reported integer not null default 0, dialog_since real);
create table if not exists meta(key text primary key, value text);
"""
COUNTED = ("pending", "sent", "failed", "dry")


class State:
    """The host ledger. Every send is recorded BEFORE it is attempted. A row that cannot be written means
    no send, and a corrupt file raises, so the tick fails closed instead of re-sending."""
    def __init__(self, path):
        Path(path).parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.db = sqlite3.connect(str(path), timeout=30, isolation_level=None)
        self.db.execute("pragma journal_mode=wal")
        self.db.executescript(SCHEMA)
        if self.db.execute("pragma quick_check").fetchone()[0] != "ok": raise sqlite3.DatabaseError("state file failed its check")

    def claim(self, kind, agent, slot, day, now, status="pending"):
        """Record a send for (kind, agent, slot). False when that slot was already used. A 'deferred' row
        (a re-check failed before anything was sent) may be claimed again on a later tick."""
        if self.db.execute("update sends set status=?, ts=?, day=? where kind=? and agent=? and slot=? and status='deferred'",
                           (status, now, day, kind, agent, slot)).rowcount:
            return True
        try:
            self.db.execute("insert into sends values(?,?,?,?,?,?)", (kind, agent, slot, day, now, status))
            return True
        except sqlite3.IntegrityError:
            return False

    def finish(self, kind, agent, slot, status):
        self.db.execute("update sends set status=? where kind=? and agent=? and slot=?", (status, kind, agent, slot))

    def count(self, kinds, agent, day):
        """Sends that count against caps. A failed attempt counts too, so failures never become a retry flood."""
        marks = ",".join("?" * len(kinds))
        return self.db.execute("select count(*) from sends where kind in (%s) and agent=? and day=? and status in (%s)"
                               % (marks, ",".join("?" * len(COUNTED))), (*kinds, agent, day, *COUNTED)).fetchone()[0]

    def has(self, kind, agent, slot):
        """A slot is used unless its only row is 'deferred'."""
        return self.db.execute("select 1 from sends where kind=? and agent=? and slot=? and status!='deferred'",
                               (kind, agent, slot)).fetchone() is not None

    def obs(self, agent):
        row = self.db.execute("select down_since, down_last, down_count, down_reported, dialog_since from obs where agent=?", (agent,)).fetchone()
        return dict(zip(("down_since", "down_last", "down_count", "down_reported", "dialog_since"), row or (None, None, 0, 0, None)))

    def set_obs(self, agent, **values):
        current = self.obs(agent); current.update(values)
        self.db.execute("insert or replace into obs values(?,?,?,?,?,?)", (agent, current["down_since"], current["down_last"],
                        current["down_count"], current["down_reported"], current["dialog_since"]))

    def meta(self, key, value=None):
        if value is None:
            row = self.db.execute("select value from meta where key=?", (key,)).fetchone()
            return row and row[0]
        self.db.execute("insert or replace into meta values(?,?)", (key, str(value)))


# ---- console -------------------------------------------------------------------------------------

class NoRedirect(urllib.request.HTTPRedirectHandler):
    """F7: urllib re-sends custom headers on a redirect; the token must never follow one."""
    def redirect_request(self, *args, **kwargs):
        return None


class Console:
    """The console calls R1 uses, and no others: sessions (list and one), input, the cron-job count, plan usage."""
    def __init__(self, url=DEFAULT_URL, token=None, opener=None):
        if not re.fullmatch(r"http://(127\.0\.0\.1|localhost)(:[0-9]{1,5})?", url): raise PolicyError("console URL must be loopback http")
        self.url, self.token = url, token
        # No proxies (a proxy variable must never carry the token off the host) and no redirects.
        self.opener = opener or urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def request(self, method, path, body=None):
        headers = {"Content-Type": "application/json"} if body is not None else {}
        if self.token: headers["X-Reverie-Service-Token"] = self.token
        data = None if body is None else json.dumps(body).encode()
        with self.opener.open(urllib.request.Request(self.url + path, data, headers, method=method), timeout=10) as response:
            raw = response.read(4 << 20)
        value = json.loads(raw) if raw else {}
        if isinstance(value, dict) and value.get("success") is False: raise RuntimeError("console refused the call")
        return value.get("data", value) if isinstance(value, dict) else value

    def sessions(self):
        return self.request("GET", "/api/v1/sessions")

    def cron_jobs(self):
        """The number of console cron jobs, and nothing else (job text is never kept or logged). Prefers the
        count-only route (console patch C7; service class under owner-auth enforce); falls back to the list
        while that route does not exist (404)."""
        try:
            value = self.request("GET", "/api/cron/count")
            count = value.get("count") if isinstance(value, dict) else None
            if isinstance(count, int) and not isinstance(count, bool) and count >= 0: return count
            raise RuntimeError("unexpected cron count")
        except urllib.error.HTTPError as error:
            if error.code != 404: raise
        jobs = self.request("GET", "/api/cron/jobs")
        if not isinstance(jobs, list): raise RuntimeError("unexpected cron list")
        return len(jobs)

    def plan_usage(self):
        return self.request("GET", "/api/subscription-profiles/usage")

    def session(self, session_id):
        if not SESSION_ID.fullmatch(session_id): raise RuntimeError("unexpected session id")
        return self.request("GET", "/api/v1/sessions/%s" % session_id)

    def send(self, session_id, text):
        """Untagged input (F2): no clientId/seq, so the console never silently drops it as a duplicate.
        A reply that says the input was buffered, dropped or a duplicate is a failure. An empty or null
        success reply (the route answers `{}`) is accepted (N3). With useMux, "sent" means the console
        accepted the input for the pane, not that the pane has shown it."""
        if not SESSION_ID.fullmatch(session_id): raise RuntimeError("unexpected session id")
        reply = self.request("POST", "/api/v1/sessions/%s/input" % session_id, {"input": text + "\r", "useMux": True})
        if reply is None: reply = {}
        if not isinstance(reply, dict) or reply.get("buffered") or reply.get("dropped") or reply.get("duplicate"):
            raise RuntimeError("input not delivered")


# ---- classification ------------------------------------------------------------------------------

def asleep(agent, local):
    """Inside the agent's sleep window (the window may wrap past midnight)."""
    now, start, end = local.time(), agent["start"], agent["end"]
    return start <= now < end if start < end else (now >= start or now < end)


def quiet_seconds(session, now):
    """Seconds since the session's last pane activity, or None when the console did not say (F4)."""
    last = session.get("lastActivityAt")
    if not isinstance(last, (int, float)) or isinstance(last, bool): return None
    return now.timestamp() - last / 1000


def live(session):
    return session.get("status") not in ("stopped", "error") and not session.get("paneExit")


def observe(sessions, agent, now):
    """(state, session) from the status fields only; pane and dialog text are never read beyond 'present'.
    States: unknown, down, moved (F5: the pinned id is gone and another live session took the name),
    renamed (F5: the pinned id carries a different name), dialog, busy, ok."""
    if not isinstance(sessions, list) or not sessions or not all(isinstance(s, dict) for s in sessions):
        return "unknown", None              # an empty or malformed list never means "everyone is down"
    pinned = [s for s in sessions if s.get("id") == agent["session_id"]]
    if len(pinned) > 1: return "unknown", None
    if not pinned or not live(pinned[0]):
        others = [s for s in sessions if s.get("name") == agent["session"] and s.get("id") != agent["session_id"] and live(s)]
        return ("moved" if others else "down"), None
    session = pinned[0]
    if session.get("name") != agent["session"]: return "renamed", None
    if session.get("paneDialog"): return "dialog", session
    if session.get("status") == "busy" or session.get("isWorking"): return "busy", session
    return "ok", session


def callable_now(session, agent, now):
    """F1/F4: a call goes only into a pinned, correctly named, idle, dialog-free pane that has been quiet
    long enough for the console's 30 s dialog scan to have caught a new prompt."""
    if not isinstance(session, dict) or session.get("id") != agent["session_id"] or session.get("name") != agent["session"]:
        return False
    if not live(session) or session.get("paneDialog") or session.get("status") == "busy" or session.get("isWorking"):
        return False
    quiet = quiet_seconds(session, now)
    return quiet is not None and quiet >= QUIET_BEFORE_CALL


# ---- the tick ------------------------------------------------------------------------------------

class Tick:
    def __init__(self, policy, state, console, report, now, live=False, paused=False):
        self.p, self.state, self.console, self.report_sink = policy, state, console, report
        self.now, self.live, self.paused = now, live, paused
        self.local = now.astimezone(policy["zone"])
        self.day = self.local.date().isoformat()
        self.events = []
        self._plan_open = None
        first = state.meta("first_tick")
        self.first_tick = float(first) if first else now.timestamp()
        if not first: state.meta("first_tick", self.first_tick)

    def report(self, code, agent="-", value=0):
        line = "routines-report v1 %s %s %s %d%s" % (self.local.isoformat(timespec="minutes"), code, agent, value,
                                                    "" if self.live else " dry-run")
        self.events.append((code, agent, value)); self.report_sink(line)

    def report_once(self, code, agent, slot, value=0):
        """A report at most once per slot (ledger kind 'report:<code>')."""
        if self.state.claim("report:" + code, agent, slot, self.day, self.now.timestamp(), "sent"):
            self.report(code, agent, value)

    def round_slot(self):
        minutes = self.local.hour * 60 + self.local.minute
        return "%s#r%d" % (self.day, minutes // self.p["every"])

    def deliver(self, kind, name, agent, slot, text, counted=CALL_KINDS, cap_key="calls_per_day"):
        """Claim the ledger row, check the cap, re-check the one session, then send. Nothing is sent
        without a written row. A failed re-check leaves the row 'deferred', so a later tick may retry
        inside the call's window; nothing was typed, so a flapping agent is never hammered."""
        if self.paused: return self.report_once("paused_skip", name, slot)
        if self.state.count(counted, name, self.day) >= self.p[cap_key]:
            return self.report_once("cap_reached", name, "%s:%s" % (kind, self.day))
        status = "pending" if self.live else "dry"
        if not self.state.claim(kind, name, slot, self.day, self.now.timestamp(), status): return
        if not self.live:
            self.report(kind + "_would_send", name); return
        if not self.console.token:
            self.state.finish(kind, name, slot, "failed"); self.report("no_token", name); return
        try:
            fresh = self.console.session(agent["session_id"])
        except Exception:
            fresh = None
        if not callable_now(fresh, agent, self.now):
            self.state.finish(kind, name, slot, "deferred"); return
        try:
            self.console.send(agent["session_id"], text)
            self.state.finish(kind, name, slot, "sent"); self.report(kind + "_sent", name)
        except Exception:
            self.state.finish(kind, name, slot, "failed"); self.report(kind + "_failed", name)

    def run(self):
        self.state.meta("heartbeat", self.now.timestamp())
        try:
            sessions = self.console.sessions()
        except Exception:
            sessions = None
        if not isinstance(sessions, list) or not sessions:
            # Unknown for everyone: no sends, and every down streak starts over (F6).
            for name in self.p["agents"]: self.reset_down(name, report=False)
            self.report_once("console_unknown", "-", self.now.strftime("%Y-%m-%dT%H"))
        else:
            for name, agent in self.p["agents"].items():
                self.agent(name, agent, sessions)
        self.cron_count()
        # F3: the agent-writable cycle policy is read last, non-blocking and capped, and is report-only.
        for mismatch in cycle_mismatches(self.p):
            self.report_once("policy_mismatch", mismatch if AGENT.fullmatch(mismatch) else "-", self.day)
        return self.events

    def agent(self, name, agent, sessions):
        state, session = observe(sessions, agent, self.now)
        if state == "unknown":
            self.reset_down(name, report=False)
            return self.report_once("unknown", name, self.round_slot())
        if state in ("moved", "renamed"):
            # F5: never follow a name to another id. The owner re-pins the policy after checking.
            self.reset_down(name, report=False)
            return self.report_once(state, name, self.day)
        self.track_down(name, state)
        if state == "down": return
        self.track_dialog(name, state)
        sleeping = asleep(agent, self.local)
        self.calls(name, agent, session, sleeping)
        self.routines(name, agent, session, sleeping)
        if sleeping: return
        slot = self.round_slot()
        if state == "dialog":
            minutes = self.dialog_minutes(name)
            if minutes >= self.p["dialog_minutes"]: self.report_once("dialog", name, slot, minutes)
            return
        quiet = quiet_seconds(session, self.now)
        if state == "busy" and quiet is not None and quiet >= self.p["stall_minutes"] * 60:
            # F1: report only. A busy pane with no output may be an unflagged permission dialog.
            self.report_once("stalled", name, slot, int(quiet // 60))

    def reset_down(self, name, report=True):
        obs = self.state.obs(name)
        if report and obs["down_reported"]: self.report("recovered", name)
        if obs["down_since"] is not None: self.state.set_obs(name, down_since=None, down_last=None, down_count=0, down_reported=0)

    def track_down(self, name, state):
        """Down is confirmed by two observations at least DOWN_MIN_SPAN apart, each within DOWN_MAX_GAP of
        the previous one, then reported once. R1 never restarts."""
        if state != "down": return self.reset_down(name)
        obs, ts = self.state.obs(name), self.now.timestamp()
        if obs["down_since"] is None or ts - obs["down_last"] > DOWN_MAX_GAP:
            return self.state.set_obs(name, down_since=ts, down_last=ts, down_count=1, down_reported=0)
        count = obs["down_count"] + (1 if ts - obs["down_last"] >= 60 else 0)
        self.state.set_obs(name, down_last=ts, down_count=count)
        if not obs["down_reported"] and count >= DOWN_OBSERVATIONS and ts - obs["down_since"] >= DOWN_MIN_SPAN:
            self.state.set_obs(name, down_reported=1)
            self.report("down", name, int((ts - obs["down_since"]) // 60))

    def track_dialog(self, name, state):
        obs = self.state.obs(name)
        if state == "dialog" and obs["dialog_since"] is None: self.state.set_obs(name, dialog_since=self.now.timestamp())
        elif state != "dialog" and obs["dialog_since"] is not None: self.state.set_obs(name, dialog_since=None)

    def dialog_minutes(self, name):
        since = self.state.obs(name)["dialog_since"]
        return 0 if since is None else int((self.now.timestamp() - since) // 60)

    def calls(self, name, agent, session, sleeping):
        if not agent["calls"]: return
        zone = self.p["zone"]
        def due(day):
            return (("wind_down", dt.datetime.combine(day, agent["start"], zone) - dt.timedelta(minutes=self.p["wind_down_before"]), WIND_DOWN_VALID),
                    ("wake", dt.datetime.combine(day, agent["end"], zone) + dt.timedelta(minutes=self.p["wake_after"]),
                     self.p["wake_retry"] * 60))
        self.slots(name, agent, session, sleeping, due, CALL_KINDS, "calls_per_day")

    def routines(self, name, agent, session, sleeping):
        """Retro (each lead, staggered), retro-compile and kickoff: fixed host texts, idle-only delivery,
        their own counter, the quota gate, weekdays only when the policy says so."""
        r = self.p.get("routines")
        if not r: return
        zone = self.p["zone"]
        def due(day):
            if r["weekdays_only"] and day.weekday() >= 5: return ()
            out = []
            retro = r.get("retro")
            # The compiler (the coordinator) gets no separate retro line: its own retro is folded into the
            # compile line, so it takes one routine input a day for the retro, not two (budget).
            if retro and name in retro["leads"] and name != retro["compiler"]:
                out.append(("retro", dt.datetime.combine(day, retro["at"], zone)
                            + dt.timedelta(minutes=retro["leads"].index(name) * r["stagger"]), retro["valid"] * 60))
            if retro and name == retro["compiler"]:
                out.append(("retro_compile", dt.datetime.combine(day, retro["at"], zone)
                            + dt.timedelta(minutes=retro["compile_after"]), retro["valid"] * 60))
            kickoff = r.get("kickoff")
            if kickoff and name == kickoff["to"]:
                out.append(("kickoff", dt.datetime.combine(day, kickoff["at"], zone), kickoff["valid"] * 60))
            return out
        self.slots(name, agent, session, sleeping, due, ROUTINE_KINDS, "routines_per_day", quota=True)

    def plan_is_open(self):
        if self._plan_open is None:
            try: self._plan_open = plan_open(self.console.plan_usage(), self.p["quota"], self.now)
            except Exception: self._plan_open = False
        return self._plan_open

    def slots(self, name, agent, session, sleeping, due_for, counted, cap_key, quota=False):
        """One shared rule for every timed send. One generic sleep guard: nothing is ever sent to an
        agent inside its sleep window, whatever the kind."""
        today = self.local.date()
        for day in (today - dt.timedelta(days=1), today, today + dt.timedelta(days=1)):
            for kind, due, valid in due_for(day):
                slot = "%s@%s" % (kind, day.isoformat())
                age = (self.now - due).total_seconds()
                if age < 0 or age >= 86400 or self.state.has(kind, name, slot): continue
                if age >= valid:
                    # Never delivered in its window: recorded once, never sent late. A slot that was due
                    # before this ledger's first tick is recorded quietly (no report noise on a first run).
                    self.state.claim(kind, name, slot, self.day, self.now.timestamp(), "missed")
                    if due.timestamp() >= self.first_tick: self.report(kind + "_missed", name)
                    continue
                if sleeping: continue
                if not callable_now(session, agent, self.now): continue
                if quota and not self.plan_is_open():
                    # Fail closed, but DEFER: nothing is sent while the plan reading is closed, stale or
                    # unreadable; a later tick inside the window may still send it, else it ends `missed`.
                    self.report_once(kind + "_deferred_quota", name, slot)
                    continue
                self.deliver(kind, name, agent, slot, TEMPLATES[kind].format(minutes=self.p["wind_down_before"]),
                             counted, cap_key)

    def cron_count(self):
        """Count-only check (U1 measure 3): report when console cron jobs exist, daily, and at once when the
        number grows. Job definitions are never read beyond their count."""
        try:
            count = self.console.cron_jobs()
        except Exception:
            return self.report_once("cron_unknown", "-", self.day)
        previous = int(self.state.meta("cron_count") or 0)
        self.state.meta("cron_count", count)
        if count > previous:
            self.report("cron_jobs_grew", "-", count)
        elif count:
            self.report_once("cron_jobs", "-", self.day, count)


# ---- command line --------------------------------------------------------------------------------

def default_paths():
    home = Path.home()
    state = Path(os.environ.get("XDG_STATE_HOME", home / ".local" / "state")) / "reverie"
    return home / ".config" / "reverie" / "routines.json", state


def main(argv=None, now=None, opener=None, out=sys.stdout):
    policy_path, state_dir = default_paths()
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", choices=("tick", "check-policy", "status"))
    parser.add_argument("--policy", type=Path, default=policy_path)
    parser.add_argument("--state-dir", type=Path, default=state_dir)
    parser.add_argument("--live", action="store_true", help="actually send; without it the tick only logs (dry run)")
    args = parser.parse_args(argv)
    try:
        policy = load_policy(args.policy)
    except PolicyError as error:
        print("routines: policy refused, nothing done: %s" % error, file=sys.stderr); return 2
    if args.command == "check-policy":
        print("routines: policy ok (%d agents, %s)" % (len(policy["agents"]), policy["timezone"]), file=out); return 0
    # Dry runs keep their own ledger, so going live never inherits "already sent" rows from a dry run.
    db = args.state_dir / ("routines.sqlite" if args.live else "routines.dry.sqlite")
    try:
        state = State(db)
    except (sqlite3.Error, OSError) as error:   # N2: a state dir that is a regular file, too
        print("routines: state %s unusable, nothing done: %s" % (db, error), file=sys.stderr); return 3
    now = now or dt.datetime.now(dt.timezone.utc)
    if args.command == "status":
        beat = state.meta("heartbeat")
        print(json.dumps({"ledger": "live" if args.live else "dry", "heartbeat": float(beat) if beat else None,
                          "obs": {n: state.obs(n) for n in policy["agents"]},
                          "today": state.db.execute("select kind, agent, slot, status from sends where day=?",
                                                    (now.astimezone(policy["zone"]).date().isoformat(),)).fetchall()}), file=out)
        return 0
    reports = args.state_dir / "routines-reports.log"
    def sink(line):
        print(line, file=out, flush=True)
        try:
            with reports.open("a") as file: file.write(line + "\n")
        except OSError:
            print("routines: report log not writable; journal only", file=sys.stderr)
    try:
        console = Console(os.environ.get("REVERIE_CONSOLE_URL", DEFAULT_URL), os.environ.get("REVERIE_SERVICE_TOKEN") or None, opener)
    except PolicyError as error:
        print("routines: %s" % error, file=sys.stderr); return 2
    paused = (args.state_dir / "routines.paused").exists()
    try:
        Tick(policy, state, console, sink, now, live=args.live, paused=paused).run()
    except sqlite3.Error as error:
        print("routines: state error, tick stopped: %s" % error, file=sys.stderr); return 3
    return 0


if __name__ == "__main__": raise SystemExit(main())
