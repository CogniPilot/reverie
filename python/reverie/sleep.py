"""Nightly sleep for every agent: consolidate the day, reflect, dream, and leave a short morning note.

One ``tick`` per timer firing. Outside the night window it returns at once. Inside it, each agent
in the policy is visited in order, under a per-agent lock:

1. consolidate: an expert's own room posts since the last pass become episodes in its own memory
   store (the post is the reply; the few room messages before it are the prompt). Episodes are
   keyed by room message id, so a repeat pass stores nothing twice. Only rooms that list one of the
   agent's sessions as a member are read, never a direct message, so no other room reaches its
   memory. An agent is its policy name (a fixed slug) plus its console company ``employee_id``: each tick
   reads the company file (``company``, read-only) for that employee's current session, so a session move
   needs no policy edit. Every session an agent has been seen with is remembered in the state directory
   (``sleep-NAME.sessions.json``), and optional ``session_ids`` add older ones, so a respawn keeps its
   history. An unknown employee is skipped (``unknown_employee``) with nothing consolidated. An entry with
   session ids and no employee id still works, with a ``deprecated_session_ids`` line each tick. Rooms come from the console's chat database
   (``chat_db``, opened read-only) or, for tests and old setups, a rooms JSON file (``chatrooms``).
   At most EPISODES_PER_PASS posts are taken per tick, oldest first, so a backlog catches up over
   several ticks. ``backfill_days`` limits how far back any pass reaches (a first pass included). An agent whose runtime
   already records its turns (``consolidate: false``) skips this step.
2. maintenance: the same pass the agent plugin runs when idle (importance ratings, then
   reflection, then a dream), gated by the GPU hold and by the agent's own 30-minute idle rule.
   The model and embedding endpoints must be local (loopback or link-local), checked on the agent's
   configuration BEFORE its store or embedder is opened (opening one probes and re-embeds), so no text
   ever reaches a hosted endpoint; otherwise the agent is refused, in a dry run too.
3. morning note: after a dream, ``morning-note.md`` in the agent's state directory holds the
   waking recall and the latest insights, capped at NOTE_CHARS and cut at a sentence end.

Before the agents, each ``prune`` entry (a JSON-lines log and its retention in days) drops the lines
whose own ``at`` timestamp is older than the retention, and every line without a readable timestamp,
then rewrites the file at mode 0600. A trailing line with no newline may be mid-append: it is kept
for one night, and dropped if the next night finds it unchanged. Lines appended during the rewrite
are carried over. An entry rewrites only with ``"live": true``; otherwise it reports what it would
drop. The global ``dry_run`` does not affect pruning.

A dry run decides only: no episodes stored, no model calls, no note (opening a store may still
create its tables and seed rows, as the runtime bridge does). Report lines carry codes and counts,
never message text.
"""
from __future__ import annotations

import argparse
import fcntl
import hashlib
import ipaddress
import json
import os
import re
import sqlite3
import sys
import time
import urllib.parse
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

NOTE_CHARS = 600
CONTEXT_MESSAGES = 3
CONTEXT_CHARS = 1500
REPLY_CHARS = 4000
PASS_SECONDS = 480
EPISODES_PER_PASS = 200  # a backlog catches up over the night's ticks; the mark advances per chunk
POLICY_KEYS = {"timezone", "window", "dry_run", "chatrooms", "chat_db", "backfill_days", "state_dir", "agents", "prune",
               "company"}
PRUNE_KEYS = {"path", "days", "live"}
AGENT_KEYS = {"name", "instance", "session_id", "session_ids", "consolidate", "employee_id"}
SLUG = re.compile(r"[a-z][a-z0-9-]{0,31}")
EMPLOYEE_ID = re.compile(r"[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}")


class PolicyError(ValueError):
    pass


def _hhmm(value: str) -> int:
    try:
        hours, minutes = (int(part) for part in value.split(":"))
    except (AttributeError, ValueError):
        raise PolicyError(f"invalid time {value!r}") from None
    if not (0 <= hours < 24 and 0 <= minutes < 60):
        raise PolicyError(f"invalid time {value!r}")
    return hours * 60 + minutes


def load_policy(path: Path) -> dict:
    raw = json.loads(Path(path).read_text())
    if not isinstance(raw, dict) or set(raw) - POLICY_KEYS:
        raise PolicyError("unknown policy keys: %s" % sorted(set(raw) - POLICY_KEYS))
    try:
        zone = ZoneInfo(raw.get("timezone", "UTC"))
    except Exception:
        raise PolicyError("unknown timezone") from None
    window = raw.get("window", {"start": "01:00", "end": "06:00"})
    start, end = _hhmm(window.get("start")), _hhmm(window.get("end"))
    agents = raw.get("agents")
    if not isinstance(agents, list) or not agents:
        raise PolicyError("at least one agent is required")
    names, employees = set(), set()
    for agent in agents:
        if not isinstance(agent, dict) or set(agent) - AGENT_KEYS or not agent.get("name") or not agent.get("instance"):
            raise PolicyError("each agent needs a name and an instance file, and nothing else")
        if not SLUG.fullmatch(str(agent["name"])):
            raise PolicyError("agent name must be a slug (lowercase letters, digits, dashes): %r" % agent["name"])
        ids = agent.get("session_ids", [])
        if not isinstance(ids, list) or not all(isinstance(i, str) and i for i in ids):
            raise PolicyError(agent["name"] + ": session_ids must be a list of session ids")
        agent["ids"] = sorted(set(ids) | ({agent["session_id"]} if agent.get("session_id") else set()))
        if "employee_id" in agent and not (isinstance(agent["employee_id"], str) and EMPLOYEE_ID.fullmatch(agent["employee_id"])):
            raise PolicyError(agent["name"] + ": employee_id must be a lowercase UUID")
        if agent["name"] in names:
            raise PolicyError("duplicate agent " + agent["name"])
        names.add(agent["name"])
        if agent.get("employee_id") in employees:
            raise PolicyError("duplicate employee_id for " + agent["name"])
        if agent.get("employee_id"):
            employees.add(agent["employee_id"])
        if agent.get("consolidate", True) and not agent["ids"] and not agent.get("employee_id"):
            raise PolicyError(agent["name"] + ": consolidation needs the agent's employee_id or console session id")
    backfill = raw.get("backfill_days")
    if backfill is not None and (type(backfill) is not int or not 1 <= backfill <= 3650):
        raise PolicyError("backfill_days must be whole days from 1 to 3650")
    if ("chatrooms" in raw) == ("chat_db" in raw):
        raise PolicyError("give exactly one of chatrooms or chat_db")
    if employees and "company" not in raw:
        raise PolicyError("agents named by employee_id need the console company file (company)")
    for key in ("chatrooms" if "chatrooms" in raw else "chat_db", "state_dir") + (("company",) if "company" in raw else ()):
        if not Path(raw.get(key, "")).is_absolute():
            raise PolicyError(key + " must be an absolute path")
    prune = raw.get("prune", [])
    if not isinstance(prune, list) or any(
            not isinstance(item, dict) or not {"path", "days"} <= set(item) <= PRUNE_KEYS
            or not Path(str(item["path"])).is_absolute() or type(item.get("live", False)) is not bool
            or type(item["days"]) is not int or not 1 <= item["days"] <= 3650 for item in prune):
        raise PolicyError("each prune entry needs an absolute path, whole days from 1 to 3650 and optionally"
                          " live true/false, and nothing else")
    return {"zone": zone, "start": start, "end": end, "dry_run": raw.get("dry_run", True) is not False,
            "chatrooms": Path(raw["chatrooms"]) if "chatrooms" in raw else None,
            "chat_db": Path(raw["chat_db"]) if "chat_db" in raw else None, "backfill_days": backfill, "state_dir": Path(raw["state_dir"]), "agents": agents,
            "company": Path(raw["company"]) if "company" in raw else None,
            "prune": [{"path": Path(item["path"]), "days": item["days"], "live": item.get("live", False)}
                      for item in prune]}


def in_window(policy: dict, now: float) -> bool:
    local = datetime.fromtimestamp(now, policy["zone"])
    minute = local.hour * 60 + local.minute
    start, end = policy["start"], policy["end"]
    return start <= minute < end if start < end else (minute >= start or minute < end)


def company_sessions(path: Path) -> dict:
    """Employee id -> current console session id, from the console company file (read only). Retired
    employees are not listed, so they resolve to nothing."""
    data = json.loads(Path(path).read_text())
    return {e["id"]: e["sessionId"] for e in data.get("employees", [])
            if isinstance(e, dict) and isinstance(e.get("id"), str) and isinstance(e.get("sessionId"), str) and e["sessionId"]}


def legacy_agents(policy: dict) -> list:
    """Agents still named only by session ids (deprecated: name them by employee_id)."""
    return [a["name"] for a in policy["agents"] if not a.get("employee_id") and a["ids"]]


def resolve_ids(agent: dict, sessions: dict | None, state_dir: Path, remember: bool = True) -> list | None:
    """Every session id this agent has had: its employee's current session from the company file, the
    sessions remembered from earlier ticks and any listed in the policy. None for an employee the company
    file does not list (or an unreadable company file), so nothing is consolidated against a partial set."""
    if not agent.get("employee_id"):
        return agent["ids"]
    current = (sessions or {}).get(agent["employee_id"])
    if not current:
        return None
    path = state_dir / ("sleep-%s.sessions.json" % agent["name"])
    try:
        seen = json.loads(path.read_text()) if path.exists() else []
        seen = [i for i in seen if isinstance(i, str) and i] if isinstance(seen, list) else []
    except ValueError:
        seen = []
    if remember and current not in seen:
        tmp = path.with_name(path.name + ".tmp")
        tmp.unlink(missing_ok=True)
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as out:
            out.write(json.dumps(sorted(set(seen) | {current})) + "\n")
        os.replace(tmp, path)
    return sorted(set(agent["ids"]) | set(seen) | {current})


def _speaker(message: dict) -> str:
    sender = message.get("from") or {}
    return "Owner" if sender.get("kind") == "user" else str(sender.get("name") or "member")


def local_endpoint(url: str) -> bool:
    """True for an empty URL or one whose host is loopback or link-local: never a hosted model."""
    if not url:
        return True
    host = urllib.parse.urlparse(url).hostname or ""
    if host == "localhost":
        return True
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return False
    return address.is_loopback or address.is_link_local


def member_of(room: dict, ids) -> bool:
    """A room (never a direct message) that lists one of these sessions as a member."""
    return not room.get("dm") and any(isinstance(m, dict) and m.get("sessionId") in ids for m in room.get("members") or [])


def load_rooms_db(path: Path, ids, since_ms: float, context: int = 12) -> list[dict]:
    """The rooms these sessions are members of, from the console chat database opened read-only, each with its
    messages after ``since_ms`` plus the ``context`` messages before that (prompt context for the first post)."""
    db = sqlite3.connect(Path(path).resolve().as_uri() + "?mode=ro", uri=True, timeout=10)
    try:
        rooms = []
        for room_id, data in db.execute("SELECT id, data FROM rooms ORDER BY id"):
            room = json.loads(data)
            if not isinstance(room, dict) or not member_of(room, ids):
                continue
            after = db.execute("SELECT data FROM messages WHERE room_id = ? AND at > ? ORDER BY at, id",
                               (room_id, int(since_ms))).fetchall()
            if not after:
                continue
            before = db.execute("SELECT data FROM messages WHERE room_id = ? AND at <= ? ORDER BY at DESC, id DESC LIMIT ?",
                                (room_id, int(since_ms), context)).fetchall()
            room["messages"] = [json.loads(row[0]) for row in reversed(before)] + [json.loads(row[0]) for row in after]
            rooms.append(room)
        return rooms
    finally:
        db.close()


def room_episodes(rooms: list, session_ids, since_ms: float) -> list[dict]:
    """This agent's own posts after ``since_ms``, each with the room messages that came before it.

    ``session_ids`` is every console session the agent has had. Rooms that do not list one of them as a
    member, direct messages and deleted messages are skipped.

    A context message that crosses a hard floor is left out, so another member's contact details never
    enter this agent's memory; the agent's own reply is screened by the caller."""
    from .floors import violates
    ids = {session_ids} if isinstance(session_ids, str) else set(session_ids)
    episodes = []
    for room in rooms:
        if not isinstance(room, dict) or not member_of(room, ids):
            continue  # direct messages and other agents' rooms stay out of memory
        messages = [m for m in room.get("messages", []) if isinstance(m, dict) and not m.get("deleted")]
        for index, message in enumerate(messages):
            sender = message.get("from") or {}
            if sender.get("sessionId") not in ids or float(message.get("at", 0)) <= since_ms:
                continue
            reply = str(message.get("text", "")).strip()
            if not reply:
                continue
            before = [m for m in messages[max(0, index - 12):index] if (m.get("from") or {}).get("sessionId") not in ids
                      and not violates(str(m.get("text", "")))]
            context = "\n".join(f"{_speaker(m)}: {m.get('text', '')}" for m in before[-CONTEXT_MESSAGES:])
            episodes.append({"source": "room:" + str(message.get("id")), "at": float(message.get("at", 0)),
                             "room": str(room.get("name") or ""),
                             "user": (f"[{room.get('name') or 'room'}]\n" + context)[-CONTEXT_CHARS:],
                             "reply": reply[:REPLY_CHARS]})
    return sorted(episodes, key=lambda e: e["at"])


def clip_at_sentence(text: str, limit: int = NOTE_CHARS) -> str:
    """At most ``limit`` characters, ending at a sentence or line end; a word cut with an ellipsis only when
    no such end falls in the second half."""
    if len(text) <= limit:
        return text
    cut = text[:limit]
    if cut[-1] in ".!?" and text[limit] in " \n":
        return cut
    end = max(cut.rfind(mark) for mark in (". ", "! ", "? ", "\n"))
    if end >= limit // 2:
        return cut[:end + 1].rstrip()
    space = cut.rfind(" ", 0, limit - 1)
    return (cut[:space] if space > 0 else cut[:limit - 1]).rstrip() + "\u2026"


def _line_time(line: bytes) -> float | None:
    try:
        return datetime.fromisoformat(json.loads(line)["at"].replace("Z", "+00:00")).timestamp()
    except Exception:  # no readable stamp: the caller drops the line
        return None


def prune_log(path: Path, cutoff: float, dry_run: bool, mark: Path) -> int:
    """Drop lines stamped before ``cutoff`` or without a readable stamp; unless a dry run, rewrite at 0600.

    A trailing line without a newline is kept one night; ``mark`` remembers its hash so the next
    night drops it if unchanged."""
    data = path.read_bytes()
    lines = data.splitlines(keepends=True)
    tail = lines.pop() if lines and not lines[-1].endswith(b"\n") else None
    keep = [line for line in lines if (_line_time(line) or 0) >= cutoff]
    seen = mark.read_text().strip() if mark.exists() else ""
    digest = hashlib.sha256(tail).hexdigest() if tail is not None else ""
    if tail is not None and digest != seen:
        keep.append(tail)
    dropped = len(lines) + (tail is not None) - len(keep)
    if dry_run:
        return dropped
    if tail is not None and digest != seen:
        mark.write_text(digest + "\n")
    else:
        mark.unlink(missing_ok=True)
    if not dropped:
        return 0
    tmp = path.with_name(path.name + ".prune-tmp")
    tmp.unlink(missing_ok=True)  # only ever this function's own leftover
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as out:
        out.write(b"".join(keep))
        out.write(path.read_bytes()[len(data):])  # appended while we filtered
        out.flush()
        os.fsync(out.fileno())
    os.replace(tmp, path)
    return dropped


def morning_note(store) -> str:
    from .dream import waking_recall
    dream = store.latest_dream()
    lines = []
    if dream:
        lines.append("Dream (%s): %s" % (time.strftime("%Y-%m-%d", time.gmtime(dream.created_at)), waking_recall(dream)))
    insights = sorted(store.reflections(), key=lambda m: m.created_at)[-3:]
    if insights:
        lines.append("Insights:")
        lines.extend("- " + m.text for m in reversed(insights))
    return clip_at_sentence("\n".join(lines))


class Sleep:
    def __init__(self, policy: dict, report, now: float, rooms: list | None = None, brain_for=None, dispatch=None,
                 config_for=None,
                 clock=time.monotonic):
        self.policy, self.report, self.now, self.clock = policy, report, now, clock
        self.rooms = rooms
        self.brain_for = brain_for or _brain_for
        self.config_for = config_for or _config_for
        self.dispatch = dispatch or _dispatch

    def line(self, code: str, agent: str = "-", count: int = 0) -> None:
        self.report("sleep v1 %s %s %s %d %s" % (time.strftime("%H:%M:%S", time.gmtime(self.now)), code, agent, count,
                                                 "dry-run" if self.policy["dry_run"] else "live"))

    def run(self) -> None:
        if not in_window(self.policy, self.now):
            return self.line("outside_window")
        if self.rooms is None and self.policy["chatrooms"] is not None:
            data = json.loads(self.policy["chatrooms"].read_text())
            rooms = data.get("rooms", data) if isinstance(data, dict) else data
            self.rooms = list(rooms.values()) if isinstance(rooms, dict) else rooms
        self.policy["state_dir"].mkdir(mode=0o700, parents=True, exist_ok=True)
        for item in self.policy.get("prune", []):
            try:
                if item["path"].exists():
                    key = hashlib.sha256(str(item["path"]).encode()).hexdigest()[:16]  # one mark per log path
                    mark = self.policy["state_dir"] / ("prune-tail-%s.sha256" % key)
                    dropped = prune_log(item["path"], self.now - item["days"] * 86400, not item["live"], mark)
                    self.line("pruned" if item["live"] else "would_prune", item["path"].name, dropped)
            except Exception as error:
                self.line("error_prune_" + type(error).__name__, item["path"].name)
        legacy = legacy_agents(self.policy)
        if legacy:
            self.line("deprecated_session_ids", ",".join(legacy), len(legacy))
        sessions = None
        if self.policy.get("company") is not None:
            try:
                sessions = company_sessions(self.policy["company"])
            except Exception as error:  # every employee-named agent is then skipped as unknown
                self.line("error_company_" + type(error).__name__, self.policy["company"].name)
        started = self.clock()
        for agent in self.policy["agents"]:
            if self.clock() - started > PASS_SECONDS:
                return self.line("pass_budget_spent", agent["name"])
            with (self.policy["state_dir"] / ("sleep-%s.lock" % agent["name"])).open("a") as lock:
                try:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    self.line("locked", agent["name"]); continue
                try:
                    ids = resolve_ids(agent, sessions, self.policy["state_dir"])
                    if ids is None:
                        self.line("unknown_employee", agent["name"]); continue
                    self.agent(dict(agent, ids=ids), started)
                except Exception as error:  # one agent's failure never stops the others
                    self.line("error_" + type(error).__name__, agent["name"])

    def agent(self, agent: dict, started: float) -> None:
        from .floors import violates
        name = agent["name"]
        cfg = self.config_for(agent["instance"])
        if not (local_endpoint(getattr(cfg, "api_base", "")) and local_endpoint(getattr(cfg, "embed_url", ""))):
            return self.line("refused_remote_model", name)
        bound = getattr(getattr(cfg, "instance", None), "employee_id", None)
        if agent.get("employee_id") and bound and bound != agent["employee_id"]:
            return self.line("refused_employee_mismatch", name)  # never one employee's posts in another's memory
        with self.brain_for(agent["instance"]) as brain:
            store = brain.store
            if agent.get("consolidate", True):
                since = float(store.get_state("sleep_consolidated_ms", "0"))
                if self.policy.get("backfill_days"):  # never reach further back than this, even on a first pass
                    since = max(since, (self.now - self.policy["backfill_days"] * 86400) * 1000)
                rooms = self.rooms if self.rooms is not None else load_rooms_db(self.policy["chat_db"], agent["ids"], since)
                episodes = room_episodes(rooms, agent["ids"], since)
                cut = EPISODES_PER_PASS
                while cut < len(episodes) and episodes[cut]["at"] == episodes[cut - 1]["at"]:
                    cut += 1  # never split posts with the same timestamp: the mark is "after this time"
                if self.policy["dry_run"]:  # the whole pending backlog, not one tick's chunk (the mark never moves)
                    self.line("would_consolidate", name, sum(not violates(e["reply"]) for e in episodes))
                episodes = episodes[:cut]
                kept = [e for e in episodes if not violates(e["reply"])]
                if not self.policy["dry_run"]:
                    self.line("consolidated", name, len(kept))
                if episodes and not self.policy["dry_run"]:
                    for episode in kept:
                        store.add_external_episode(episode["source"], episode["user"], episode["reply"], "private")
                    store.set_state("sleep_consolidated_ms", str(episodes[-1]["at"]))
                    store.set_state("reverie_last_activity", str(episodes[-1]["at"] / 1000))
            if self.policy["dry_run"]:
                last = float(store.get_state("reverie_last_activity", str(self.now)))
                due = [p for p, ok in (("reflect", brain.reflector.due(self.now)),
                                       ("dream", brain.dreamer.due(last, self.now))) if ok]
                return self.line("would_" + "_".join(due) if due else "nothing_due", name)
            dreamed = False
            while self.clock() - started <= PASS_SECONDS:
                result = self.dispatch(brain, {"action": "maintenance"})
                action = result.get("action") or "skipped"
                self.line(action, name, int(result.get("count") or 0))
                dreamed = dreamed or action == "dreamed"
                if action not in ("rated", "reflected"):
                    break
            if dreamed:
                note = morning_note(store)
                path = brain.cfg.data_dir / "morning-note.md"
                path.write_text(note + "\n")
                path.chmod(0o644)
                self.line("morning_note", name, len(note))


def _config_for(instance: str):
    """The agent's configuration only: no store, embedder or model client is opened."""
    from .config import Config
    return Config(instance_config=Path(instance))


class _brain_for:
    """The agent's own Brain, built exactly as its runtime bridge builds it, closed afterwards."""

    def __init__(self, instance: str):
        self.instance = instance

    def __enter__(self):
        from .chat import ChatDaemon
        from .config import Config
        self.daemon = ChatDaemon(Config(instance_config=Path(self.instance)))
        return self.daemon.brain

    def __exit__(self, *exc):
        self.daemon.brain.store.close()


def _dispatch(brain, request):
    from .opencode import dispatch
    return dispatch(brain, request)


def main(argv=None, out=None) -> int:
    out = out or sys.stdout
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("action", choices=("tick", "check-policy"))
    parser.add_argument("--policy", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        policy = load_policy(args.policy)
    except (OSError, ValueError) as error:
        print("sleep v1 policy_refused: %s" % error, file=out)
        return 2
    if args.action == "check-policy":
        print("policy ok: %d agents, %s" % (len(policy["agents"]), "dry-run" if policy["dry_run"] else "live"), file=out)
        if legacy_agents(policy):
            print("deprecated_session_ids %s: name these agents by employee_id" % ",".join(legacy_agents(policy)), file=out)
        if policy["company"] is None:
            return 0
        try:
            sessions = company_sessions(policy["company"])
        except (OSError, ValueError) as error:
            print("company unreadable: %s" % type(error).__name__, file=out)
            return 1
        unknown = 0
        for agent in policy["agents"]:
            ids = resolve_ids(agent, sessions, policy["state_dir"], remember=False)
            if ids is None:
                unknown += 1
                print("unknown_employee %s %s" % (agent["name"], agent["employee_id"]), file=out)
            elif agent.get("employee_id"):
                print("resolved %s employee %s -> session %s (%d known)" % (
                    agent["name"], agent["employee_id"][:8], sessions[agent["employee_id"]][:8], len(ids)), file=out)
        print("resolved %d of %d agents" % (len(policy["agents"]) - unknown, len(policy["agents"])), file=out)
        return 1 if unknown else 0
    policy["state_dir"].mkdir(mode=0o700, parents=True, exist_ok=True)
    with (policy["state_dir"] / "sleep.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print("sleep v1 previous_tick_running", file=out)
            return 0
        log_path = policy["state_dir"] / "sleep.log"

        def report(line: str) -> None:
            print(line, file=out, flush=True)
            # The same coded line (codes and counts only, never message text), readable inside the container.
            with log_path.open("a") as log:
                log.write(line + "\n")

        Sleep(policy, report, time.time()).run()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
