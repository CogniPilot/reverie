"""Stall watchdog for a local OpenCode agent: notices a turn that stopped making progress and nudges it.

The runtime watcher (`reverie.runtime`) handles crashes. This module handles the agent that is alive but
stuck:
- a busy turn with no new assistant output and no pane change for `busy_stall_minutes`
- an idle agent that never answered its last input
- a turn stopped by OpenCode's own step-limit notice
- a pane dialog, or a room delivery queue that does not drain (reported only)
- **shell mode**: a `!` typed into OpenCode's prompt switches it to shell mode, so room deliveries
  run as bash commands and the agent never sees them

What it does, escalating per episode:
1. paste `continue`
2. interrupt (Esc twice) and paste a neutral "resume" note (never a resent room message)
3. report `needs_attention`: a coded line for the host, which writes and posts the notice
   (`scripts/stall-watch-host`; nothing in the container is trusted with words or the token)

Shell mode is ended with Esc (verified on the pane), and the agent is then told which rooms to
re-read. It never starts a new session or thread and never restarts anything.

**It fails safe.** It acts only when it can see clearly and should act:
- **Blind, so it does nothing:** the OpenCode database or the pane could not be read this tick, or the
  console's thread is not the newest one in the agent's directory.
- **Holding, so it does nothing:** the runtime watcher is mid-recovery (a candidate, an uncertain
  creation, a recent recovery) or holds its lock right now.
- **Report-only, never typing or pressing Esc:**
  - a tool or a reasoning stream is still running
  - the night window
  - the GPU lock held by a non-chat role (a dream, training, a review)
  - a GPU hold file
  - the owner's or the watchdog's pause file
- **Bounded:** at most `max_nudges` inputs per `nudge_window_minutes`. The count and the episode step
  are saved before any action, and nothing is done if that save fails.

Run once per timer tick: `python -m reverie.stall_watch --config FILE [--dry-run]`. Every observation that
matters and every action is appended to the JSONL log, without message text. The OpenCode database is
opened read-only, and only its `session`, `message` and `part` rows for the target are read.
"""
from __future__ import annotations

import argparse
import base64
import fcntl
import hashlib
import json
import os
import re
import shlex
import signal
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

DEFAULTS = {
    "api_url": "http://127.0.0.1:3000",
    "opencode_db": "~/.local/share/opencode/opencode.db",
    "tmux_socket": "reverie",
    "busy_stall_minutes": 6,
    "tool_stall_minutes": 30,
    "idle_unanswered_minutes": 4,
    "max_steps_grace_minutes": 1,
    "dialog_minutes": 4,
    "step_wait_minutes": 3,
    "recovery_quiet_minutes": 10,
    "max_nudges": 3,
    "nudge_window_minutes": 30,
    "pause_file": None,
    # The runtime watcher's policy: its owner-pause file and its state (recovery in progress).
    "runtime_policy": None,
    # The night window: from the cycle policy (`night` + `timezone`), else {"start", "end", "timezone"}.
    "cycle_policy": None,
    "night": None,
    "gpu_lock": "~/.cache/gpu.lock",
    "hold_files": ["~/reverie/runtime/gpu.hold", "~/.cache/reverie.hold"],
    "log_max_bytes": 1024 * 1024,
    "tick_seconds": 60,
}
NUDGE = "continue"
RESUME_NOTE = ("[stall-watch] Your turn stopped making progress, so it was interrupted. Resume the task you were on; "
               "if you need the context, re-read your rooms with reverie agent chat read.")
MAX_INPUT_CHARS = 3000
# OpenCode's own step-limit notice (compared with whitespace collapsed). Best effort: OpenCode adds it
# to the model request only, so it is in the database only when the model's reply echoes it.
MAX_STEPS_NOTICE = ("CRITICAL - MAXIMUM STEPS REACHED\nThe maximum number of steps allowed for this task has been "
                    "reached. Tools are disabled until next user input.")
DELIVERY_PREFIX = "[Reverie chat "
NOTE_PREFIX = "[stall-watch]"
ROOM_OF_DELIVERY = re.compile(r'^\[Reverie chat "((?:[^"\\]|\\.)*)"\]')
SPINNER = re.compile("[0-9⠀-⣿■-◿⬝⬞]")   # digits, braille spinners, progress blocks
REPORT_ONLY = ("dialog", "stuck_queue", "long_tool", "slow_reasoning")
GPU_ROLES = ("chat", "review", "train", "dream")
REPORT_LINE = "stall-watch-report v1"
REPORT_KINDS = ("shell_mode", "missed_deliveries", "dialog", "busy_stall", "long_tool", "slow_reasoning",
                "max_steps", "stuck_queue", "unanswered")
TRIED_BITS = {"continue": 1, "interrupt + resume note": 2, "esc": 4, "re-read note": 8}
QUIET_BITS = {"night": 1, "gpu:dream": 2, "gpu:train": 4, "gpu:review": 8, "gpu:unknown": 16, "hold": 32,
              "owner_pause": 64}
FIRST_RUN_LOOKBACK = 15 * 60
HTTP_TIMEOUT = 10


def load_config(path):
    config = dict(DEFAULTS, **json.loads(Path(path).read_text()))
    for key in ("state_file", "log_file"):
        if not config.get(key): raise ValueError("configure " + key)
    target = config.get("target") or {}
    if not (target.get("session_id") or target.get("name")): raise ValueError("configure target.session_id or target.name")
    for key in ("busy_stall_minutes", "tool_stall_minutes", "idle_unanswered_minutes", "max_steps_grace_minutes",
                "dialog_minutes", "step_wait_minutes", "nudge_window_minutes", "recovery_quiet_minutes"):
        if not isinstance(config[key], (int, float)) or not 0 < config[key] <= 24 * 60:
            raise ValueError(key + " must be between 0 and 1440 minutes")
    if not isinstance(config["max_nudges"], int) or not 0 <= config["max_nudges"] <= 20:
        raise ValueError("max_nudges must be 0-20")
    if config.get("report_as") is not None:
        raise ValueError("report_as is gone: reports are room notices, posted on the host by stall-watch-host "
                         "with its service token; remove report_as from the config")
    night = config.get("night")
    if night is not None:
        if not all(re.fullmatch(r"([01]\d|2[0-3]):[0-5]\d", str(night.get(k, ""))) for k in ("start", "end")):
            raise ValueError("night needs HH:MM start and end")
        try: ZoneInfo(str(night.get("timezone")))
        except (KeyError, ValueError) as error: raise ValueError("night needs a valid IANA timezone") from error
    return config


# ---------------------------------------------------------------------------------------------
# Observation (I/O). Each probe returns plain data, so `assess` and `plan` are pure and testable.
# ---------------------------------------------------------------------------------------------

def unwrap(value):
    """The console's `{success, data}` envelope: the data, or an error."""
    if isinstance(value, dict) and value.get("success") is False:
        raise RuntimeError(value.get("error", "the console rejected the call"))
    return value.get("data", value) if isinstance(value, dict) else value


class Console:
    """The console's HTTP API, read directly (no service token: none is ever held in the container).
    Works while owner sign-in is off or in `log`; under `enforce` use `FedConsole` instead."""

    def __init__(self, url):
        self.url = url.rstrip("/")
        endpoint = urllib.parse.urlsplit(self.url)
        if endpoint.scheme not in ("http", "https") or not endpoint.hostname or endpoint.username or endpoint.password:
            raise ValueError("configure a console API URL without embedded credentials")

    def call(self, method, path, body=None):
        headers = {"Content-Type": "application/json"}
        password = os.environ.get("REVERIE_PASSWORD")
        if password:
            raw = (os.environ.get("REVERIE_USERNAME", "admin") + ":" + password).encode()
            headers["Authorization"] = "Basic " + base64.b64encode(raw).decode()
        data = json.dumps(body).encode() if body is not None else None
        request = urllib.request.Request(self.url + path, data=data, method=method, headers=headers)
        with urllib.request.urlopen(request, timeout=HTTP_TIMEOUT) as response:
            return unwrap(json.load(response))


class FedConsole:
    """The two console reads a tick needs, fetched by the HOST with its service token and handed over
    on stdin (`--console-json -`): `{"sessions": <GET /api/v1/sessions>, "chatrooms": <GET
    /api/chatrooms>}`, raw responses. The token never enters the container."""

    PATHS = {"/api/v1/sessions": "sessions", "/api/chatrooms": "chatrooms"}

    def __init__(self, text):
        fed = json.loads(text)
        if not isinstance(fed, dict) or not all(key in fed for key in self.PATHS.values()):
            raise ValueError("console JSON needs sessions and chatrooms")
        self.fed = fed

    def call(self, method, path, body=None):
        if method != "GET" or path not in self.PATHS:
            raise RuntimeError("only the host-fed reads are available: " + path)
        return unwrap(self.fed[self.PATHS[path]])


def find_target(sessions, target):
    """The watched session: by id, else the one LIVE OpenCode session with that name. A stopped
    leftover with the same name is ignored; two live ones are an error, never a guess."""
    sessions = sessions if isinstance(sessions, list) else (sessions or {}).get("sessions", [])
    if target.get("session_id"):
        found = [s for s in sessions if s.get("id") == target["session_id"]]
    else:
        found = [s for s in sessions if s.get("name") == target["name"] and s.get("mode") == "opencode"
                 and s.get("pid") is not None]
    if len(found) > 1: raise LookupError("%d live sessions named %r; set target.session_id" % (len(found), target.get("name")))
    return found[0] if found else None


def pending_deliveries(rooms, session_id):
    """Undelivered room lines queued for the session, summed over its rooms."""
    total = 0
    for room in rooms if isinstance(rooms, list) else (rooms or {}).get("rooms", []):
        for member in room.get("members", []):
            if member.get("sessionId") == session_id: total += int(member.get("pendingDeliveries") or 0)
    return total


def read_native(db_path, native_session, cwd=None):
    """What the OpenCode database says about the session. Read-only; only `session`, `message` and
    `part` rows. Raises `sqlite3.Error` when the database cannot be read: the caller then does nothing."""
    uri = "file:" + urllib.parse.quote(str(Path(db_path).expanduser())) + "?mode=ro"
    db = sqlite3.connect(uri, uri=True, timeout=5)
    try:
        newest = None
        if cwd:
            row = db.execute("select id, time_updated from session where directory=? and parent_id is null "
                             "order by time_updated desc limit 1", (cwd,)).fetchone()
            newest = row if row else None
        sid = native_session
        configured = sid and db.execute("select time_updated from session where id=?", (sid,)).fetchone()
        if not configured:
            sid = newest[0] if newest else None
        if not sid: return None
        # The console names the thread it started; if the agent's directory has a newer top-level
        # thread, the agent moved on and this one's timing would mislead.
        mismatch = bool(configured and newest and newest[0] != sid and newest[1] > configured[0])
        q = lambda sql, *args: db.execute(sql, (sid, *args)).fetchone()
        role = "json_extract(m.data,'$.role')"
        # A line typed into the prompt while it was in shell mode is stored as a bash tool call "executed
        # by the user": a room delivery, or this watchdog's own note.
        command = "json_extract(p.data,'$.state.input.command')"
        eaten_sql = ("json_extract(p.data,'$.type')='tool' and json_extract(p.data,'$.tool')='bash' "
                     "and (" + command + " like ? or " + command + " like ?)")
        eaten_args = (DELIVERY_PREFIX + "%", NOTE_PREFIX + "%")
        last_part = q("select max(time_updated) from part where session_id=?")[0]
        last_assistant = q("select max(p.time_updated) from part p join message m on m.id=p.message_id "
                           "where p.session_id=? and " + role + "='assistant' and not (" + eaten_sql + ")",
                           *eaten_args)[0]
        last_user = q("select max(m.time_created) from message m join part p on p.message_id=m.id "
                      "where m.session_id=? and " + role + "='user' and json_extract(p.data,'$.type')='text' "
                      "and coalesce(json_extract(p.data,'$.synthetic'),0)=0")[0]
        # The newest message, and whether its turn is still running: an open tool call or reasoning
        # stream means the agent is working, however quiet.
        newest_message = q("select id, " + role + ", json_extract(m.data,'$.time.completed') from message m "
                           "where m.session_id=? order by m.time_created desc limit 1")
        running_tool = open_reasoning = max_steps = None
        if newest_message and newest_message[1] == "assistant":
            mid = newest_message[0]
            running_tool = db.execute(
                "select min(time_created) from part where message_id=? and json_extract(data,'$.type')='tool' "
                "and json_extract(data,'$.state.status') in ('running','pending')", (mid,)).fetchone()[0]
            open_reasoning = db.execute(
                "select min(time_created) from part where message_id=? and json_extract(data,'$.type')='reasoning' "
                "and json_extract(data,'$.time.end') is null", (mid,)).fetchone()[0]
            notice = " ".join(MAX_STEPS_NOTICE.split())
            max_steps = max((at for at, text in db.execute(
                "select time_updated, json_extract(data,'$.text') from part where message_id=? "
                "and json_extract(data,'$.type')='text' and json_extract(data,'$.text') like 'CRITICAL - MAXIMUM STEPS REACHED%'",
                (mid,)) if " ".join(str(text).split()).startswith(notice)), default=None)
        eaten = [{"at_ms": at, "room": room_of(text), "own": text.startswith(NOTE_PREFIX)} for at, text in db.execute(
            "select p.time_created, " + command + " from part p "
            "where p.session_id=? and " + eaten_sql + " order by p.time_created desc limit 50",
            (sid, *eaten_args))]
        return {"session": sid, "thread_mismatch": mismatch, "last_part_ms": last_part,
                "last_assistant_ms": last_assistant, "last_user_ms": last_user,
                "running_tool_ms": running_tool, "open_reasoning_ms": open_reasoning,
                "max_steps_ms": max_steps, "eaten": eaten}
    finally:
        db.close()


def room_of(command):
    match = ROOM_OF_DELIVERY.match(command or "")
    return match.group(1).replace('\\"', '"') if match else None


def read_pane(text):
    """OpenCode's prompt box (the `┃` rows above the `╹▀` border) and the hint row under it."""
    lines = text.rstrip("\n").splitlines()
    border = max((i for i, line in enumerate(lines) if line.lstrip().startswith("╹")), default=None)
    composer, hint, top = [], "", len(lines)
    if border is not None:
        hint = " ".join(line.strip() for line in lines[border + 1:border + 3])
        top = border
        while top > 0 and lines[top - 1].lstrip().startswith("┃"):
            top -= 1; composer.insert(0, lines[top].lstrip()[1:].strip())
    # In shell mode the prompt's status row reads just "Shell" (not "Chat · <model>") and the hint
    # row offers "esc exit shell mode".
    shell = "shell mode" in hint.lower() or any(row == "Shell" for row in composer)
    # The transcript above the prompt box: what the agent shows, not what anyone is typing.
    # Digits and spinner glyphs (timers, progress) are not progress.
    signature = hashlib.sha1(" ".join(SPINNER.sub("", " ".join(lines[:top])).split()).encode()).hexdigest()
    return {"shell_mode": bool(shell), "found_prompt": border is not None, "signature": signature}


def in_window(window, now):
    """Whether `now` (epoch seconds) falls in a daily HH:MM-HH:MM window (it may wrap past midnight)."""
    local = datetime.fromtimestamp(now, ZoneInfo(window["timezone"]))
    minute = local.hour * 60 + local.minute
    start, end = (int(v[:2]) * 60 + int(v[3:5]) for v in (window["start"], window["end"]))
    return (minute - start) % 1440 < (end - start) % 1440


def gpu_holder(path, proc_locks="/proc/locks"):
    """The holder of the shared GPU lock ({} when free). Read from /proc/locks, never by taking the
    lock: even a brief probe could collide with a tenant acquiring it. The role comes from the JSON
    the holder writes into the lock file."""
    path = Path(path).expanduser()
    if not flock_held(path, proc_locks): return {}
    try: holder = json.loads(path.read_text() or "{}")
    except (OSError, ValueError): holder = {}
    return holder or {"role": "unknown"}


def flock_held(path, proc_locks="/proc/locks"):
    """Whether any process holds a flock on `path`, read from /proc/locks without taking one (a probe
    lock, even a shared one, could make the runtime watcher's own non-blocking take fail)."""
    try: st = os.stat(path)
    except FileNotFoundError: return False
    device = "%02x:%02x:%d" % (os.major(st.st_dev), os.minor(st.st_dev), st.st_ino)
    with open(proc_locks) as locks:
        return any(len(f) > 5 and f[1] == "FLOCK" and f[5] == device for f in (line.split() for line in locks))


def runtime_hold(runtime_state, recovery_quiet_seconds, now, lock_held):
    """Why the runtime watcher's work must not be disturbed now, or None."""
    if lock_held: return "the runtime watcher holds its lock"
    if runtime_state.get("candidate"): return "the runtime watcher is activating a new session"
    if runtime_state.get("creation_uncertain"): return "the runtime watcher's last creation is uncertain"
    recent = [at for at in runtime_state.get("recovery_attempts", []) if isinstance(at, (int, float))
              and now - at < recovery_quiet_seconds]
    if recent: return "the runtime watcher recovered a session %d s ago" % (now - max(recent))
    return None


# ---------------------------------------------------------------------------------------------
# Decisions (pure)
# ---------------------------------------------------------------------------------------------

def track_progress(state, pane, now):
    """Remember when the pane's transcript last changed, as seen by this watchdog."""
    sig = (pane or {}).get("signature")
    if sig != state.get("pane_sig"): state.update(pane_sig=sig, pane_since=now)


def assess(obs, state, config, now):
    """The condition that needs attention, or None. `obs` holds session, native, pane and pending."""
    session, native, pane = obs["session"], obs.get("native") or {}, obs.get("pane") or {}
    if session is None or session.get("pid") is None: return None   # the crash watcher's job
    busy = session.get("status") == "busy" or bool(session.get("isWorking"))
    minutes = lambda key: config[key] * 60
    ms = lambda value: (value or 0) / 1000
    if pane.get("shell_mode"):
        since = state.setdefault("shell_since", now)   # one episode per occurrence
        if not busy: return {"kind": "shell_mode", "anchor": since}
    else:
        state.pop("shell_since", None)
    handled = state.get("eaten_handled_ms") or 0
    missed = [e for e in native.get("eaten", []) if e["at_ms"] > handled]
    if missed and not busy:
        return {"kind": "missed_deliveries", "anchor": missed[0]["at_ms"], "missed": missed,
                "own": any(e["own"] for e in missed)}
    if session.get("paneDialog"):
        since = state.setdefault("dialog_since", now)
        if now - since >= minutes("dialog_minutes"):
            return {"kind": "dialog", "anchor": since}
        return None
    state.pop("dialog_since", None)
    if busy:
        quiet_since = max(ms(native.get("last_assistant_ms")), state.get("pane_since") or 0)
        quiet = now - quiet_since if quiet_since else 0
        if native.get("running_tool_ms"):
            # A tool runs silently until it ends: alive. Only a very long one is reported.
            if quiet >= minutes("tool_stall_minutes"):
                return {"kind": "long_tool", "anchor": native["running_tool_ms"], "quiet_minutes": round(quiet / 60, 1)}
            return None
        if quiet >= minutes("busy_stall_minutes"):
            if native.get("open_reasoning_ms"):
                return {"kind": "slow_reasoning", "anchor": native.get("last_assistant_ms"), "quiet_minutes": round(quiet / 60, 1)}
            return {"kind": "busy_stall", "anchor": native.get("last_assistant_ms"), "quiet_minutes": round(quiet / 60, 1)}
        return None
    steps = native.get("max_steps_ms")
    if steps and steps > (native.get("last_user_ms") or 0) and now - ms(steps) >= minutes("max_steps_grace_minutes"):
        return {"kind": "max_steps", "anchor": steps}
    if obs.get("pending", 0) > 0:
        since = state.setdefault("pending_since", now)
        if now - since >= minutes("idle_unanswered_minutes"):
            return {"kind": "stuck_queue", "anchor": since, "pending": obs["pending"]}
    else:
        state.pop("pending_since", None)
    # The last input: the console's (it also counts input a dialog swallowed) or the DB's (it also
    # counts this watchdog's pasted nudges, which the console does not see).
    submitted = max(session.get("lastSubmitAt") or 0, native.get("last_user_ms") or 0)
    answered = native.get("last_assistant_ms") or 0
    if submitted and submitted > answered + 1000 and now - ms(submitted) >= minutes("idle_unanswered_minutes"):
        # Anchored on the last answer, not the last input: the watchdog's own nudges are inputs.
        return {"kind": "unanswered", "anchor": native.get("last_assistant_ms")}
    return None


def nudges_left(state, config, now):
    window = config["nudge_window_minutes"] * 60
    state["nudges"] = [at for at in state.get("nudges", []) if now - at < window]
    return config["max_nudges"] - len(state["nudges"])


EPISODE_MAX_SECONDS = 2 * 3600


def plan(condition, state, config, now, progress=None, report_only=False):
    """The next action for the condition: 'continue', 'interrupt_resume', 'exit_shell', 'reread',
    'report' or None (wait). Episode bookkeeping lives in `state['episode']`.

    An episode ends only when the agent makes progress (`progress`, its newest assistant output,
    moves past the episode's) or after two hours. A condition that merely disappears for a while
    (a nudge was typed, so the pane changed) does not reset the escalation. With `report_only`
    nothing is typed and no key is pressed: the only possible action is one report."""
    episode = state.get("episode")
    if episode and ((progress or 0) > (episode.get("progress") or 0) or now - episode["started"] > EPISODE_MAX_SECONDS):
        state.pop("episode", None); episode = None
    if condition is None: return None
    if not episode or episode.get("kind") != condition["kind"] or episode.get("anchor") != condition["anchor"]:
        episode = state["episode"] = {"kind": condition["kind"], "anchor": condition["anchor"], "step": 0,
                                      "started": now, "last_action": None, "reported": False, "progress": progress}
    kind = condition["kind"]
    if report_only or kind in REPORT_ONLY:
        return None if episode["reported"] else "report"
    if kind == "shell_mode":
        # Leaving shell mode protects every later delivery, so it is not counted as a nudge; it is
        # only rate-limited, and reported if it does not stick.
        if episode["last_action"] and now - episode["last_action"] < 60: return None
        if episode["step"] < 2: return "exit_shell"
        return None if episode["reported"] else "report"
    if episode["last_action"] and now - episode["last_action"] < config["step_wait_minutes"] * 60: return None
    if kind == "missed_deliveries":
        # If the watchdog's own note ran as bash too, typing more cannot help: report.
        if episode["step"] == 0 and not condition.get("own") and nudges_left(state, config, now) > 0:
            return "reread"
        return None if episode["reported"] else "report"
    if episode["step"] >= 2 or nudges_left(state, config, now) <= 0:
        return None if episode["reported"] else "report"
    return "continue" if episode["step"] == 0 else "interrupt_resume"


def reread_text(missed):
    missed = [e for e in missed if not e.get("own")]
    rooms = sorted({e["room"] for e in missed if e.get("room")})
    where = ", ".join(json.dumps(room) for room in rooms) or "your rooms"
    commands = "; ".join("reverie agent chat read --room %s -n 10" % shlex.quote(room) for room in rooms) \
        or "reverie agent chat read"
    return (NOTE_PREFIX + " Your prompt was in shell mode, so %d room message(s) ran as bash and you never saw them (%s). "
            "Read them now: %s. Then answer anything still open." % (len(missed), where, commands))


def one_line(text):
    return " ".join(str(text or "").split())[:MAX_INPUT_CHARS]


# ---------------------------------------------------------------------------------------------
# Actions
# ---------------------------------------------------------------------------------------------

TYPING_ACTIONS = ("continue", "interrupt_resume", "reread")


class Watchdog:
    def __init__(self, config, console=None, run=subprocess.run, sleep=time.sleep, dry_run=False,
                 proc_locks="/proc/locks"):
        self.config, self.dry_run, self.run, self.sleep = config, dry_run, run, sleep
        self.proc_locks = proc_locks
        self.console = console or Console(os.environ.get("REVERIE_API_URL", config["api_url"]))
        state_file = Path(config["state_file"]).expanduser()
        self.state_path = state_file.with_suffix(".dry.json") if dry_run else state_file
        self.log_path = Path(config["log_file"]).expanduser()
        self.outbox = []

    # state and log
    def load_state(self):
        try: return json.loads(self.state_path.read_text())
        except (OSError, ValueError): return {}

    def save_state(self, state):
        tmp = self.state_path.with_name(self.state_path.name + ".tmp")
        tmp.write_text(json.dumps(state)); os.chmod(tmp, 0o600); tmp.replace(self.state_path)

    def log(self, **entry):
        entry = {"at": round(time.time(), 3), **({"dry_run": True} if self.dry_run else {}), **entry}
        try:
            if self.log_path.exists() and self.log_path.stat().st_size > self.config["log_max_bytes"]:
                self.log_path.replace(self.log_path.with_name(self.log_path.name + ".1"))
            with open(self.log_path, "a") as handle: handle.write(json.dumps(entry) + "\n")
            os.chmod(self.log_path, 0o600)
        except OSError as error:
            print("stall-watch: cannot write the log: %s" % error, file=sys.stderr)

    def log_once(self, state, key, value, **entry):
        """Log only when `value` changed since the last tick (errors that repeat every minute)."""
        if state.get(key) != value:
            if value is not None: self.log(**entry)
            state[key] = value

    # observation
    def observe(self):
        session = find_target(self.console.call("GET", "/api/v1/sessions"), self.config["target"])
        obs = {"session": session, "native": None, "pane": None, "pending": 0}
        if not session: return obs
        native_id = (session.get("openCodeConfig") or {}).get("continueSession")
        try: obs["native"] = read_native(self.config["opencode_db"], native_id, session.get("workingDir"))
        except sqlite3.Error as error: obs["native_error"] = str(error)
        if obs["native"] is None and "native_error" not in obs: obs["native_error"] = "no OpenCode thread found"
        try: obs["pane"] = read_pane(self.capture(session))
        except (OSError, RuntimeError, subprocess.SubprocessError) as error: obs["pane_error"] = str(error)
        try: obs["pending"] = pending_deliveries(self.console.call("GET", "/api/chatrooms"), session["id"])
        except (OSError, RuntimeError, ValueError) as error: obs["rooms_error"] = str(error)
        return obs

    def blind(self, obs):
        """Why this tick cannot see clearly enough to act at all, or None."""
        if obs.get("native_error"): return "cannot read the OpenCode database: " + obs["native_error"][:200]
        if obs.get("pane_error"): return "cannot read the pane: " + obs["pane_error"][:200]
        if not obs["pane"].get("found_prompt"): return "the pane shows no OpenCode prompt"
        if obs["native"].get("thread_mismatch"): return "thread_mismatch: the agent's directory has a newer thread"
        return None

    def runtime(self):
        """The runtime watcher's policy, its state, whether its lock is held now, and a resolver for its
        relative paths. Empty when not configured; raises when configured but unreadable (the
        caller then holds)."""
        path = self.config.get("runtime_policy")
        if not path: return {}, {}, False, lambda v: Path(v).expanduser()
        policy_path = Path(path).expanduser()
        policy = json.loads(policy_path.read_text())
        resolve = lambda v: (Path(v).expanduser() if Path(v).expanduser().is_absolute() else policy_path.parent / v)
        state_path = resolve(policy["state_file"])
        try: state = json.loads(state_path.read_text())
        except FileNotFoundError: state = {}
        held = flock_held(state_path.with_suffix(".lock"), self.proc_locks)
        return policy, state, held, resolve

    def quiet_reasons(self, now, runtime_policy, resolve):
        """Why only reporting is allowed now (never typing, never Esc): the night window, the GPU
        lock held by a non-chat role, a hold file, or a pause file."""
        reasons = []
        window = self.config.get("night")
        if self.config.get("cycle_policy"):
            cycle = json.loads(Path(self.config["cycle_policy"]).expanduser().read_text())
            if cycle.get("night"): window = dict(cycle["night"], timezone=cycle.get("timezone", "UTC"))
        if window and in_window(window, now): reasons.append("night")
        holder = gpu_holder(self.config["gpu_lock"], self.proc_locks)
        # The holder's role is read from a file agents can write: only a fixed code is kept.
        role = holder.get("role") if holder.get("role") in GPU_ROLES else "unknown"
        if holder and role != "chat": reasons.append("gpu:" + role)
        if any(Path(hold).expanduser().exists() for hold in self.config.get("hold_files") or []): reasons.append("hold")
        owner_pause = runtime_policy.get("pause_file")
        if owner_pause and resolve(owner_pause).exists(): reasons.append("owner_pause")
        return reasons

    def mux(self, session):
        return session.get("muxName") or "reverie-" + session["id"][:8]

    # effects
    def keys(self, session, *keys):
        if self.dry_run: return
        self.tmux("send-keys", "-t", self.mux(session), *keys)

    def tmux(self, *args, stdin=None):
        out = self.run(["tmux", "-L", self.config["tmux_socket"], *args], input=stdin,
                       capture_output=True, text=True, timeout=10)
        if out.returncode != 0: raise RuntimeError("tmux %s failed: %s" % (args[0], (out.stderr or "").strip()[:200]))
        return out.stdout

    def capture(self, session):
        return self.tmux("capture-pane", "-p", "-t", self.mux(session), "-S", "-60")

    def type(self, session, text, busy=False):
        """Paste one line and press Enter. Typed keystrokes are not safe in OpenCode: a '!' anywhere
        switches the prompt to shell mode and the line would run as bash. A bracketed paste
        (`paste-buffer -p`) arrives as one paste event, so the text stays text. The prompt must not be
        in shell mode; it is taken out of it first, but never mid-turn (one Esc then would arm an
        interrupt)."""
        if self.dry_run: return
        if read_pane(self.capture(session))["shell_mode"]:
            if busy or not self.exit_shell(session):
                raise RuntimeError("the prompt is in shell mode; nothing was typed")
        buffer = "stall-watch-%d" % os.getpid()
        # The tick's deadline must not fall between the paste and its Enter: text left in the prompt
        # would be prefixed to the next room delivery. The alarm waits until the line is sent.
        signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGALRM})
        try:
            self.tmux("load-buffer", "-b", buffer, "-", stdin=one_line(text))
            self.tmux("paste-buffer", "-p", "-d", "-b", buffer, "-t", self.mux(session))
            self.sleep(0.2)
            self.keys(session, "Enter")
        finally:
            signal.pthread_sigmask(signal.SIG_UNBLOCK, {signal.SIGALRM})

    def report(self, session, condition, episode, quiet):
        """Queue a CODED report for the host: the condition's kind, one bounded number, when the
        episode started, and bit masks of what was tried and why nudging was off. No text, no names,
        no rooms: everything here runs as the agents' uid, so the host trusts none of it as words.
        `stall-watch-host` validates every field and writes the notice from its own templates, with the
        agent's name, the rooms and the recipients from host config. A dry run queues nothing."""
        code = report_code(condition, episode, quiet)
        if self.dry_run: return {"would_report": code}
        self.outbox.append(code)
        return {"queued_for_host": code}

    def exit_shell(self, session):
        """Esc leaves OpenCode's shell mode, verified on the pane."""
        self.keys(session, "Escape")
        if self.dry_run: return True
        self.sleep(1)
        return not read_pane(self.capture(session))["shell_mode"]

    # one tick
    def tick(self, now=None):
        now = time.time() if now is None else now
        pause = self.config.get("pause_file")
        if pause and Path(pause).expanduser().exists(): return {"paused": True}
        state = self.load_state()
        try:
            obs = self.observe()
        except (OSError, RuntimeError, ValueError, LookupError) as error:
            self.log_once(state, "observe_error", str(error)[:300], event="observe_failed", error=str(error)[:300])
            self.save_state(state)
            return {"error": str(error)}
        self.log_once(state, "observe_error", None)
        session = obs["session"]
        if session is None:
            if state.get("session_id"): self.log(event="target_missing", target=self.config["target"])
            state["session_id"] = None; self.save_state(state); return {"target": None}
        if session["id"] != state.get("session_id"):
            # A new target (or the first run): only deliveries eaten in the last FIRST_RUN_LOOKBACK
            # are still worth a re-read note.
            state = {"session_id": session["id"], "eaten_handled_ms": int((now - FIRST_RUN_LOOKBACK) * 1000),
                     "nudges": state.get("nudges", [])}
        for key in ("native_error", "pane_error", "rooms_error"):
            self.log_once(state, key, obs.get(key), event=key, error=(obs.get(key) or "")[:300])

        blind = self.blind(obs)
        hold, quiet = None, []
        if not blind:
            try:
                runtime_policy, runtime_state, lock_held, resolve = self.runtime()
                hold = runtime_hold(runtime_state, self.config["recovery_quiet_minutes"] * 60, now, lock_held)
                quiet = self.quiet_reasons(now, runtime_policy, resolve)
            except (OSError, ValueError, KeyError) as error:
                hold = "cannot read the runtime or cycle policy: %s" % str(error)[:200]
        if blind or hold:
            # Fail safe: no typing, no keys, no reports, no episode changes. Logged when it changes.
            self.log_once(state, "standing_down", blind or hold, event="standing_down", reason=blind or hold)
            state["last_tick"] = now; self.save_state(state)
            return {"condition": None, "action": None, "standing_down": blind or hold}
        self.log_once(state, "standing_down", None)

        track_progress(state, obs.get("pane"), now)
        condition = assess(obs, state, self.config, now)
        action = plan(condition, state, self.config, now, obs["native"].get("last_assistant_ms"), report_only=bool(quiet))
        if condition and (action or state.get("logged") != [condition["kind"], condition["anchor"]]):
            state["logged"] = [condition["kind"], condition["anchor"]]
            self.log(event="condition", condition=describe(condition), kind=condition["kind"], session=session["id"],
                     **({"report_only": quiet} if quiet else {}))
        result = None
        if action:
            # Write-ahead: the episode step and the nudge count are saved BEFORE acting. If that save
            # fails, nothing is done, so a broken disk can never lift the cap.
            pending = self.commit(action, condition, state, obs, now)
            try:
                self.save_state(state)
            except OSError as error:
                self.log(event="action_skipped", action=action, reason="cannot save state: %s" % str(error)[:200])
                return {"condition": condition["kind"], "action": None, "error": "state not saved"}
            result = self.act(action, condition, session, state, pending, quiet)
            self.log(event="action", action=action, kind=condition["kind"], session=session["id"], result=result)
        state["last_tick"] = now
        try: self.save_state(state)
        except OSError as error: self.log(event="state_save_failed", error=str(error)[:200])
        return {"condition": condition and condition["kind"], "action": action, "result": result}

    def commit(self, action, condition, state, obs, now):
        """Record an action in the state before doing it; returns what the action needs."""
        episode = state["episode"]
        episode["last_action"] = now
        episode.setdefault("tried", [])
        pending = {}
        if action == "report":
            episode["reported"] = True
        elif action == "exit_shell":
            episode["step"] += 1; episode["tried"].append("esc")
            missed = [e for e in obs["native"].get("eaten", []) if e["at_ms"] > (state.get("eaten_handled_ms") or 0)]
            if missed and nudges_left(state, self.config, now) > 0:
                pending["missed"] = missed
                state["nudges"].append(now)
                state["eaten_handled_ms"] = missed[0]["at_ms"]
        else:
            episode["step"] += 1
            episode["tried"].append({"continue": "continue", "interrupt_resume": "interrupt + resume note",
                                     "reread": "re-read note"}[action])
            state["nudges"].append(now)
            if action == "reread": state["eaten_handled_ms"] = condition["anchor"]
        return pending

    def act(self, action, condition, session, state, pending, quiet):
        episode = state["episode"]
        busy = session.get("status") == "busy" or bool(session.get("isWorking"))
        try:
            if action == "report":
                return self.report(session, condition, episode, quiet)
            if action == "exit_shell":
                if not self.exit_shell(session):
                    episode["step"] = 2
                    return {"shell_mode": "still on"}
                if pending.get("missed"):
                    self.type(session, reread_text(pending["missed"]))
                    episode["tried"].append("re-read note")
                    return {"shell_mode": "ended", "reread": len([e for e in pending["missed"] if not e.get("own")])}
                return {"shell_mode": "ended"}
            if action == "reread":
                self.type(session, reread_text(condition["missed"]))
                return {"reread": len([e for e in condition["missed"] if not e.get("own")])}
            if action == "continue":
                self.type(session, NUDGE, busy=busy)
                return {"typed": NUDGE}
            if action == "interrupt_resume":
                self.keys(session, "Escape"); self.sleep(0.3); self.keys(session, "Escape")
                if not self.dry_run: self.sleep(2)
                self.type(session, RESUME_NOTE)
                return {"interrupted": True, "typed": "resume note"}
        except (OSError, RuntimeError, ValueError, subprocess.SubprocessError) as error:
            return {"failed": str(error)[:300]}
        return None


def describe(condition):
    kind = condition["kind"]
    return {
        "shell_mode": "the prompt is in shell mode, so room deliveries run as bash",
        "missed_deliveries": "%d room message(s) ran as bash while in shell mode" % len(condition.get("missed", [])),
        "dialog": "a pane dialog is open",
        "busy_stall": "busy with no progress for %s min" % condition.get("quiet_minutes"),
        "long_tool": "a tool has been running without output for %s min" % condition.get("quiet_minutes"),
        "slow_reasoning": "reasoning without new output for %s min" % condition.get("quiet_minutes"),
        "max_steps": "stopped at OpenCode's step limit",
        "stuck_queue": "%s room deliveries are queued and not draining" % condition.get("pending"),
        "unanswered": "idle without answering its last input",
    }.get(kind, kind)


class TickTimeout(Exception):
    pass


def report_code(condition, episode, quiet):
    """The coded form of a report: only an enum, bounded integers and masks."""
    kind = condition["kind"]
    if kind in ("busy_stall", "long_tool", "slow_reasoning"): n = condition.get("quiet_minutes") or 0
    elif kind == "missed_deliveries": n = len(condition.get("missed", []))
    elif kind == "stuck_queue": n = condition.get("pending") or 0
    else: n = 0
    tried = 0
    for step in episode.get("tried") or []: tried |= TRIED_BITS.get(step, 0)
    quiet_mask = 0
    for reason in quiet or []: quiet_mask |= QUIET_BITS.get(reason, 0)
    return {"kind": kind, "n": max(0, min(int(n), 100000)), "started": int(episode.get("started") or time.time()),
            "tried": tried, "quiet": quiet_mask}


def report_lines(outbox):
    """What the host reads: `stall-watch-report v1 <kind> <n> <started> <tried> <quiet>`, one per report."""
    return ["%s %s %d %d %d %d" % (REPORT_LINE, c["kind"], c["n"], c["started"], c["tried"], c["quiet"]) for c in outbox]


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--config", required=True)
    parser.add_argument("--dry-run", action="store_true", help="observe, decide and log; never type, press keys or post")
    parser.add_argument("--console-json", metavar="FILE", help="read the console's sessions and rooms from FILE ('-' = stdin), "
                        "as fetched by the host with its service token, instead of calling the console")
    args = parser.parse_args(argv)
    config = load_config(args.config)
    lock_path = Path(config["state_file"]).expanduser().with_suffix(".lock")
    with open(lock_path, "a") as lock:
        try: fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print("stall-watch: another tick is running"); return 0

        # A tick never outlives its timer slot: systemd's timeout ends only the podman client, so the
        # tick ends itself rather than act late while the next one starts.
        def expire(*_): raise TickTimeout()
        signal.signal(signal.SIGALRM, expire)
        signal.alarm(max(10, int(config["tick_seconds"]) - 5))
        try:
            fed = None
            if args.console_json:
                try:
                    fed = FedConsole(sys.stdin.read() if args.console_json == "-" else Path(args.console_json).read_text())
                except (OSError, ValueError) as error:
                    print(json.dumps({"error": "unusable console JSON: %s" % str(error)[:200]})); return 1
            dog = Watchdog(config, console=fed, dry_run=args.dry_run)
            result = dog.tick()
        except TickTimeout:
            print(json.dumps({"error": "tick timed out"})); return 1
        finally:
            signal.alarm(0)
    for line in report_lines(dog.outbox): print(line)
    print(json.dumps(result))
    return 1 if "error" in result else 0


if __name__ == "__main__":
    sys.exit(main())
