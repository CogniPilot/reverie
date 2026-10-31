"""Reverie runtime handoffs using the compatible upstream API. Policy and continuity state live outside the code repo."""
from __future__ import annotations
import argparse
import fcntl
import base64
import json
import os
import re
import signal
import stat
import urllib.parse
from pathlib import Path
import time
import urllib.error
import urllib.request
import uuid

from reverie.admission import session_admission
from reverie.instance import parse_instance
from reverie import env_names


def atomic_write(path, value):
    path = Path(path); path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w") as file:
        json.dump(value, file, indent=2); file.write("\n")
    temporary.replace(path)


# Newest decisive lifecycle event for a session that no longer exists.
DISAPPEARANCE = {"deleted":"deleted", "mux_died":"restart", "stale_cleaned":"restart"}
# Phases the watcher never leaves on its own; `activate` or the owner resets them.
STOPPED = ("owner_closed", "clean_exit", "missing_needs_owner", "needs_owner", "candidate_failed")
# Reverie's memory brief for the calling agent (GET /api/agent/memory-brief, memory-brief.ts) starts with this and is bounded
# server side (MEMORY_BRIEF_MAX there is 1800 characters).
MEMORY_BRIEF = "Your memory:"
MEMORY_BRIEF_MAX = 4000
RECOVERY_NOTE = ("Automatic recovery: do not accept dialogs, and do not rerun interrupted or uncertain jobs;"
                 " review them first.")


SESSION_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9-]{0,99}")
CONVERSATION_ID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
PERSONA_CHARS = 2000


EFFORT_LEVELS = frozenset({"low", "medium", "high", "xhigh", "max"})
MARKER_BYTES = 4096
INSTANCE_BYTES = 64 * 1024


def read_regular(path, limit, from_end=False):
    """At most limit bytes of a regular file (the last ones with from_end). A symlink as the last path
    component, a FIFO or a device is refused with OSError, so an agent-writable path can never block
    the caller or stream without end."""
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | getattr(os, "O_CLOEXEC", 0))
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode): raise OSError(f"not a regular file: {path}")
        if from_end: os.lseek(fd, max(0, info.st_size - limit), os.SEEK_SET)
        return os.read(fd, limit)   # one read: a regular file returns all of it up to EOF
    finally: os.close(fd)


def observed_effort(conversation, projects, tail=512 * 1024):
    """Effort level of the newest record in a Claude Code transcript that names one, or None.

    Claude Code writes the effort of each turn into its transcript; the console only knows a
    spawn-time default, which /effort can change in the session. Reads the file's tail only."""
    if not isinstance(conversation, str) or not CONVERSATION_ID.fullmatch(conversation): return None
    try: files = sorted(Path(projects).glob("*/" + conversation + ".jsonl"), key=lambda path: path.stat().st_mtime)
    except OSError: return None
    if not files: return None
    try: data = read_regular(files[-1], tail, from_end=True)
    except OSError: return None
    for raw in reversed(data.splitlines()):   # the first line after the seek may be cut; it just fails to parse
        try: record = json.loads(raw)
        except ValueError: continue
        if isinstance(record, dict) and record.get("effort") in EFFORT_LEVELS:
            at = record.get("timestamp")
            return {"level": record["effort"], "at": at if isinstance(at, str) and len(at) <= 64 else None}
    return None


def coordinator_of(room):
    """A room's coordinator, from coordinatorId or a member's role (Reverie derives one from the other)."""
    return room.get("coordinatorId") or next(
        (member.get("sessionId") for member in room.get("members", []) if member.get("role") == "coordinator"), None)


class Reverie:
    def __init__(self, url):
        self.url = url.rstrip("/")
        endpoint = urllib.parse.urlsplit(self.url)
        if endpoint.scheme not in ("http", "https") or not endpoint.hostname or endpoint.username or endpoint.password:
            raise ValueError("configure a Reverie HTTP API URL without embedded credentials")

    def call(self, method, path, body=None):
        headers = {"Content-Type":"application/json"}
        parent = os.environ.get("REVERIE_SESSION_ID")
        if parent: headers["X-Reverie-Parent-Session"] = parent
        password = os.environ.get("REVERIE_PASSWORD")
        if password:
            raw = (os.environ.get("REVERIE_USERNAME", "admin") + ":" + password).encode()
            headers["Authorization"] = "Basic " + base64.b64encode(raw).decode()
        data = json.dumps(body).encode() if body is not None else None
        request = urllib.request.Request(self.url + path, data=data, method=method, headers=headers)
        with urllib.request.urlopen(request, timeout=45) as response:
            value = json.load(response)
        if isinstance(value, dict) and value.get("success") is False:
            raise RuntimeError(value.get("error", "Reverie rejected the operation"))
        return value.get("data", value) if isinstance(value, dict) else value




class Runtime:
    def __init__(self, policy_path, api=None, cgroup=Path("/sys/fs/cgroup")):
        self.cgroup = Path(cgroup)
        self.policy_path = Path(policy_path).expanduser().resolve(strict=True)
        self.policy = json.loads(self.policy_path.read_text())
        self.state_path = self.resolve(self.policy["state_file"])
        self.api = api or Reverie(os.environ.get("REVERIE_API_URL", self.policy["api_url"]))
        self.state = json.loads(self.state_path.read_text()) if self.state_path.exists() else {}
        fallback = self.policy["fallback"]
        if fallback not in self.policy["backends"] or not self.policy["backends"][fallback].get("enabled"):
            raise ValueError("an enabled local fallback is required")
        if self.policy["backends"][fallback]["mode"] != "opencode":
            raise ValueError("the fallback must use the local OpenCode adapter")

    def resolve(self, value):
        path = Path(value).expanduser()
        return path if path.is_absolute() else (self.policy_path.parent / path).resolve()

    def save(self): atomic_write(self.state_path, self.state)

    def local_health(self):
        config = self.policy.get("keep_alive")
        if not config:
            return {"configured": False}
        url = config["model_api_url"].rstrip("/")
        endpoint = urllib.parse.urlsplit(url)
        if endpoint.scheme not in ("http", "https") or not endpoint.hostname or endpoint.username or endpoint.password or endpoint.query or endpoint.fragment:
            raise ValueError("configure a model API URL without embedded credentials, query or fragment")
        profile_model = self.policy["backends"][self.policy["fallback"]]["model"].split("/", 1)[-1]
        if config["model_id"] != profile_model:
            raise ValueError("keep-alive probe and fallback must select the same local model")
        timeout = config.get("probe_timeout_seconds", 5)
        if not isinstance(timeout, (int, float)) or not 0 < timeout <= 30:
            raise ValueError("model probe timeout must be between 0 and 30 seconds")
        headers = {}
        if config.get("api_key_env"):
            token = os.environ.get(config["api_key_env"])
            if not token:
                return {"ready": False, "reason": "model API credential is missing"}
            headers["Authorization"] = "Bearer " + token
        request = urllib.request.Request(url + "/models", headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                value = json.load(response)
            matches = [model for model in value.get("data", []) if model.get("id") == config["model_id"]]
            if not matches:
                return {"ready": False, "reason": "selected local model is not registered"}
            if matches[0].get("status", {}).get("value") in ("failed", "error"):
                return {"ready": False, "reason": "selected local model reports an error"}
            return {"ready": True, "model": config["model_id"],
                    "note": "registered model; inference readiness and GPU allocation require server verification"}
        except (OSError, ValueError, TypeError, AttributeError):
            return {"ready": False, "reason": "model endpoint unavailable or invalid"}

    def session_name(self, backend):
        """Owner-configured persistent identity; legacy policies retain their labels."""
        name = self.policy.get("session_name")
        if name is not None:
            if not isinstance(name, str) or not name.strip() or len(name) > 100:
                raise ValueError("session_name must be nonempty text of at most 100 characters")
            return name.strip()
        return "CTO · " + backend

    def start(self, backend, handoff):
        if not handoff.strip(): raise ValueError("save a handoff before changing runtimes")
        if self.state.get("candidate") or self.state.get("creation_uncertain"):
            raise ValueError("resolve the pending handoff before creating another session")
        profile = self.policy["backends"].get(backend, {})
        if not profile.get("enabled"): raise ValueError("backend is not enabled by the owner")
        mode = profile.get("mode")
        if mode not in ("opencode", "codex", "claude"): raise ValueError("unsupported backend adapter")
        memory = session_admission(self.policy, mode, self.cgroup)
        if not memory["admitted"]: raise ValueError("memory admission refused: " + memory["reason"])
        if backend == self.policy["fallback"] and self.policy.get("keep_alive"):
            health = self.local_health()
            if not health.get("ready"):
                raise ValueError("local keep-alive unavailable: " + health["reason"])
        body = {"caseName":profile.get("case_name", self.policy["case_name"]), "mode":mode,
                "sessionName":self.session_name(backend)}
        if mode == "claude": body["model"] = profile["model"]
        else: body["openCodeConfig" if mode == "opencode" else "codexConfig"] = {"model":profile["model"]}
        self.state.update(handoff=handoff, requested_backend=backend, creation_uncertain=True)
        self.save()  # Persist BEFORE creating; an ambiguous response must not duplicate agents.
        value = self.api.call("POST", "/api/v1/quick-start", body)
        session = value.get("session", value)
        session_id = (value.get("sessionId") or session.get("id")) if isinstance(session, dict) else None
        if not session_id: raise RuntimeError("Reverie returned no session id; inspect before retrying")
        self.state.update(candidate=session_id, candidate_backend=backend, creation_uncertain=False,
                          phase="awaiting_verified_handoff", candidate_created_at=time.time(),
                          candidates_seen=self.state.get("candidates_seen", [])[-19:] + [session_id])
        self.save()
        # Only once the candidate is on disk: a fresh backend remembers nothing else, so its first prompt starts with the agent's
        # memory brief. One line, since `reverie agent send` refuses newlines and tabs; the saved handoff keeps its own lines,
        # and every start reads the brief afresh.
        brief = self.memory_brief()
        first_prompt = " ".join((brief + " " + handoff if brief else handoff).split())
        self.state.update(first_prompt=first_prompt)
        self.save()
        return {"session_id":session_id, "backend":backend, "phase":self.state["phase"], "first_prompt":first_prompt,
                "memory_brief":"added" if brief else "unavailable",
                "next":"Read its screen; when its composer is ready send first_prompt, then the read-rules prompt (runtime skill)."
                       " Verify memory and chat membership, then activate."}

    def activate(self, session_id):
        if session_id != self.state.get("candidate"): raise ValueError("not the pending candidate")
        live = self.api.call("GET", "/api/v1/sessions/" + session_id)
        live = live.get("session", live)
        if live.get("pid") is None or live.get("paneExit") or live.get("paneDialog"):
            raise ValueError("candidate is not healthy or needs attention")
        room = self.policy.get("room_id")
        if room and coordinator_of(self.api.call("GET", "/api/v1/chatrooms/" + room + "?limit=0")) != session_id:
            raise ValueError("owner must transfer the room's coordinator role; keep the old runtime")
        previous = self.state.get("current")
        # Freeze what the replaced runtime held BEFORE switching; healthy ticks never overwrite it.
        source = self.restore_source(previous, session_id)
        self.state.update(current=session_id, backend=self.state["candidate_backend"], candidate=None,
                          phase="running", previous=previous, current_name=live.get("name"),
                          current_dir=live.get("workingDir"), last_seen_at=time.time(), restore_source=source)
        self.save()
        try: bindings = self.restore_bindings(session_id)
        except (OSError, RuntimeError, KeyError, ValueError, TypeError) as error:  # the frozen source stays for a retry
            bindings = {"error":str(error), "retry":"reverie-runtime restore-bindings " + session_id}
        # Never delete a previous session automatically. The caller verifies the
        # handoff and closes the exact old id using Reverie's normal guarded CLI.
        return {"current":session_id, "previous":previous, "bindings":bindings}

    def is_clean_exit(self, pane_exit):
        # Only an explicit numeric 0 without a signal is clean; tmux reports a
        # SIGKILLed pane (e.g. the OOM killer) with no status at all.
        status = pane_exit.get("status")
        return type(status) is int and status == 0 and pane_exit.get("signal") is None

    def disappearance(self, session_id):
        """Classify a missing session from lifecycle events logged after it was last seen alive.

        Reverie's log reads newest first and honours `since`; an older restart
        event (an earlier container restart) can therefore never count."""
        seen = self.state.get("last_seen_at")
        if not seen: return "unknown"
        since = int(seen * 1000)
        try:
            value = self.api.call("GET", "/api/v1/session-lifecycle?" + urllib.parse.urlencode(
                {"sessionId": session_id, "since": since, "limit": 200}))
        except (OSError, ValueError, RuntimeError):
            return "unknown"
        entries = value.get("entries", []) if isinstance(value, dict) else []
        decisive = [entry for entry in entries if isinstance(entry, dict) and entry.get("event") in DISAPPEARANCE
                    and isinstance(entry.get("ts"), (int, float)) and entry["ts"] > since]
        if not decisive: return "unknown"
        return DISAPPEARANCE[max(decisive, key=lambda entry: entry["ts"])["event"]]

    def memory_brief(self):
        """The replaced agent's own memory brief, or '' when it cannot be read here.

        Reverie answers GET /api/agent/memory-brief for the calling agent only. So the brief is there when an agent switches or
        reboots itself (this process runs in its session), and not when another session, such as a watcher, starts the
        replacement: the new session then reads its memory itself, as the runtime skill's second prompt tells it to."""
        current = self.state.get("current")
        if not current or os.environ.get("REVERIE_SESSION_ID") != current: return ""
        try: value = self.api.call("GET", "/api/v1/agent/memory-brief")
        except (OSError, ValueError, RuntimeError, KeyError, TypeError): return ""
        text = value.get("text") if isinstance(value, dict) else None
        if not isinstance(text, str) or not text.startswith(MEMORY_BRIEF) or len(text) > MEMORY_BRIEF_MAX: return ""
        return text

    def bindings(self, session_id):
        """Room memberships and company employees currently bound to session_id."""
        rooms = self.api.call("GET", "/api/v1/chatrooms?" + urllib.parse.urlencode({"member": session_id}))
        rooms = rooms.get("rooms", []) if isinstance(rooms, dict) else rooms
        memberships = [{"room_id": room["id"], "room": room.get("name"),
                        "role": "coordinator" if coordinator_of(room) == session_id else member.get("role", "agent")}
                       for room in rooms for member in room.get("members", []) if member.get("sessionId") == session_id]
        company = self.api.call("GET", "/api/v1/company")
        employees = [{"employee_id": employee["id"], "name": employee.get("name")}
                     for employee in company.get("employees", []) if employee.get("sessionId") == session_id]
        return {"session": session_id, "rooms": memberships, "employees": employees}

    def remember_bindings(self, session_id, now):
        known = self.state.get("bindings") or {}
        refresh = self.policy.get("binding_refresh_seconds", 300)
        if known.get("session") == session_id and now - known.get("observed_at", 0) < refresh: return
        try: observed = self.bindings(session_id)
        except (OSError, ValueError, RuntimeError, KeyError, TypeError): return  # keep the last good snapshot
        self.state["bindings"] = dict(observed, observed_at=now); self.save()

    def restore_source(self, previous, session_id):
        """What the replaced runtime held: a live read now, plus the last healthy-tick snapshot of it."""
        if not previous or previous == session_id: return None
        remembered = self.state.get("bindings") or {}
        remembered = remembered if remembered.get("session") == previous else {}
        try: live, note = self.bindings(previous), None
        except (OSError, ValueError, RuntimeError, KeyError, TypeError):
            live, note = {}, "live read of the previous runtime failed; using the last snapshot"
        rooms = {room["room_id"]: room for source in (remembered, live) for room in source.get("rooms", [])}
        employees = {e["employee_id"]: e for source in (remembered, live) for e in source.get("employees", [])}
        if not rooms and not employees: note = "no binding snapshot of the previous runtime"
        return {"from": previous, "to": session_id, "rooms": list(rooms.values()),
                "employees": list(employees.values()), "note": note}

    def adoption_matches(self, dead_id):
        """Live sessions that already carry this agent identity in this case, e.g. one recovered by hand."""
        names = {name for name in [self.state.get("current_name")] if name}
        names |= {self.session_name(name) for name in self.policy["backends"]}
        excluded = {dead_id, self.state.get("previous"), os.environ.get("REVERIE_SESSION_ID"),
                    *self.state.get("candidates_seen", [])} - {None}
        home = self.state.get("current_dir")
        value = self.api.call("GET", "/api/v1/sessions")
        sessions = value.get("sessions", value) if isinstance(value, dict) else value
        return [session for session in sessions or [] if isinstance(session, dict)
                and session.get("id") and session["id"] not in excluded
                and session.get("name") and session["name"] in names
                and session.get("pid") is not None and not session.get("paneExit")
                and (session.get("workingDir") == home if home
                     else Path(session.get("workingDir") or "").name == self.policy["case_name"])]

    def backend_of(self, session):
        """The policy backend an existing session runs, from its own name/mode; None when unknown."""
        enabled = {name: profile for name, profile in self.policy["backends"].items() if profile.get("enabled")}
        name = session.get("name") or ""
        if name.startswith("CTO · ") and enabled.get(name[6:], {}).get("mode") == session.get("mode"):
            return name[6:]
        same_mode = [name for name, profile in enabled.items() if profile.get("mode") == session.get("mode")]
        return same_mode[0] if len(same_mode) == 1 else None

    def adoptable(self, session):
        """Only a replacement started after the runtime was last seen alive, on the same adapter.

        Sharing a working dir is not identity (the coordinator runs in the CTO dir), so a renamed
        older session or one on another adapter is never adopted."""
        dead_mode = self.policy["backends"].get(self.state.get("backend"), {}).get("mode")
        seen = self.state.get("last_seen_at")
        created = session.get("createdAt")
        return (dead_mode is not None and session.get("mode") == dead_mode and bool(seen)
                and isinstance(created, (int, float)) and created > seen * 1000
                and self.backend_of(session) is not None)

    def alert_channel_problem(self, room):
        """Why this watcher cannot post as itself; None when it is a live member of the room."""
        watcher = os.environ.get("REVERIE_SESSION_ID")
        if not room: return "no alert_room configured"
        if not watcher: return "watcher has no session identity of its own"
        if watcher in {self.state.get("current"), self.state.get("candidate"), *self.state.get("candidates_seen", [])}:
            return "watcher shares a supervised runtime's identity"
        try:
            own = self.api.call("GET", "/api/v1/sessions/" + urllib.parse.quote(watcher))
            own = own.get("session", own)
            if own.get("pid") is None or own.get("paneExit"): return "watcher session is not live"
            view = self.api.call("GET", "/api/v1/chatrooms/" + urllib.parse.quote(room) + "?limit=0")
        except (OSError, RuntimeError, ValueError, AttributeError) as error:
            return "cannot verify watcher identity: " + str(error)
        if not any(member.get("sessionId") == watcher for member in view.get("members", [])):
            return "watcher is not a member of the alert room"
        return None

    def alert(self, text):
        """Tell the coordinator under this watcher's own verified identity, never as the user.

        Reverie posts as the user when a parent session does not resolve, so the identity is
        verified first, `requireAgent` asks the server to refuse instead (an older server rejects
        the unknown field), and the returned sender is checked. Anything else is kept in state."""
        room = self.policy.get("alert_room")
        result = {"alert": text}
        problem = self.alert_channel_problem(room)
        if problem is None:
            try:
                value = self.api.call("POST", "/api/v1/chatrooms/" + urllib.parse.quote(room) + "/messages",
                                      {"text": "[reverie-runtime] " + text, "to": ["coordinator"], "requireAgent": True})
                sender = ((value or {}).get("message") or {}).get("from") or {}
                if sender.get("kind") == "agent" and sender.get("sessionId") == os.environ["REVERIE_SESSION_ID"]:
                    result["posted"] = room
                else:
                    problem = "MISATTRIBUTED: alert was posted as %r; tell the owner" % (sender.get("kind"),)
            except (OSError, RuntimeError, ValueError, TypeError, AttributeError) as error:
                problem = "post failed: " + str(error)
        if problem:
            result["undelivered"] = problem
            self.state["undelivered_alerts"] = self.state.get("undelivered_alerts", [])[-19:] + [
                {"at": time.time(), "alert": text, "reason": problem}]
            self.save()
        return result

    def needs_owner(self, phase, text, **extra):
        self.state["phase"] = phase; self.save()
        return dict(self.alert(text), blocked=text, **extra)

    def recover(self, now, reason):
        attempts = [at for at in self.state.get("recovery_attempts", []) if now-at < 900]
        if len(attempts) >= int(self.policy.get("max_recoveries", 3)):
            return self.needs_owner("needs_owner", "recovery budget exhausted")
        matches = self.adoption_matches(self.state.get("current"))
        if len(matches) > 1:
            return self.needs_owner("needs_owner", "several live sessions carry the configured agent identity",
                                    sessions=[session["id"] for session in matches])
        if matches and not self.adoptable(matches[0]):
            # Something live already claims the identity; creating another would duplicate it.
            return self.needs_owner("needs_owner", "live session with the configured agent identity cannot be verified",
                                    sessions=[matches[0]["id"]])
        if matches:
            backend = self.backend_of(matches[0])
            # Adopt for verification instead of creating a second runtime for one identity.
            self.state.update(candidate=matches[0]["id"], candidate_backend=backend, phase="awaiting_verified_handoff",
                              recovery_reason=reason,
                              candidates_seen=self.state.get("candidates_seen", [])[-19:] + [matches[0]["id"]])
            self.save()
            return {"adopted":matches[0]["id"], "backend":backend, "phase":self.state["phase"], "reason":reason}
        if self.policy.get("keep_alive"):
            health = self.local_health()
            if not health.get("ready"):
                return {"blocked": "local keep-alive unavailable", "local": health}
        mode = self.policy["backends"][self.policy["fallback"]]["mode"]
        memory = session_admission(self.policy, mode, self.cgroup)
        if not memory["admitted"]:  # an OOM-killed runtime must not be replaced into the same OOM
            return {"blocked": "memory admission refused", "memory": memory}
        self.state.update(recovery_attempts=attempts + [now], recovery_reason=reason); self.save()
        handoff = self.state.get("handoff") or "Read the durable plan and recover the previous work; verify state before acting."
        return self.start(self.policy["fallback"], handoff + " " + RECOVERY_NOTE)

    def restore_bindings(self, session_id):
        """Move the replaced runtime's rooms/employees to session_id, only where it still holds them.

        Holders are re-read now: a binding the owner moved or removed since the
        snapshot is left alone. Refusals and coordinator roles become owner actions."""
        source = self.state.get("restore_source")
        if not source or source.get("to") != session_id:
            return {"restored":[], "owner_actions":[], "skipped":[], "note":"no restore pending"}
        replaced = source["from"]
        restored, owner_actions, skipped = [], [], []
        def attempt(label, method, path, body):
            try: self.api.call(method, path, body); restored.append(label)
            except urllib.error.HTTPError as error:
                if error.code not in (401, 403): raise
                # Never strip caller identity to get around a refusal; the owner decides.
                owner_actions.append(label)
        for room in source.get("rooms", []):
            label = "join room " + str(room.get("room") or room["room_id"])
            try: view = self.api.call("GET", "/api/v1/chatrooms/" + urllib.parse.quote(room["room_id"]) + "?limit=0")
            except urllib.error.HTTPError as error:
                if error.code != 404: raise
                skipped.append(label + " (room deleted)"); continue
            members = {member.get("sessionId") for member in view.get("members", [])}
            coordinator = coordinator_of(view)
            if replaced not in members and session_id not in members:
                skipped.append(label + " (previous runtime was removed)"); continue
            if room.get("role") == "coordinator" or coordinator == replaced:
                if coordinator != session_id: owner_actions.append(label + " as coordinator")  # owner-only
                continue
            if session_id in members: continue
            attempt(label, "POST", "/api/v1/chatrooms/" + urllib.parse.quote(room["room_id"]) + "/members",
                    {"sessionId": session_id})
        holders = {e.get("id"): e.get("sessionId") for e in self.api.call("GET", "/api/v1/company").get("employees", [])}
        for employee in source.get("employees", []):
            label = "bind employee " + str(employee.get("name") or employee["employee_id"])
            if employee["employee_id"] not in holders: skipped.append(label + " (employee removed)"); continue
            holder = holders[employee["employee_id"]]
            if holder == session_id: continue
            if holder not in (replaced, None, ""):
                owner_actions.append(label + " (now bound to another session)"); continue
            attempt(label, "PUT", "/api/v1/company/employees/" + urllib.parse.quote(employee["employee_id"]) + "/session",
                    {"sessionId": session_id})
        if not owner_actions: self.state.pop("restore_source", None)  # complete; keep it while owner work remains
        self.state["owner_actions"] = owner_actions; self.save()
        return {"restored":restored, "owner_actions":owner_actions, "skipped":skipped, "note":source.get("note")}

    def current_is_live(self):
        current = self.state.get("current")
        if not current: return False
        try: live = self.api.call("GET", "/api/v1/sessions/" + current)
        except urllib.error.HTTPError as error:
            if error.code != 404: raise
            return False
        live = live.get("session", live)
        return live.get("pid") is not None and not live.get("paneExit")

    def reset(self, creation_inspected=False):
        """Owner command: leave a stopped phase and resume supervision of `current`.

        It never abandons a live candidate (that would leave two runtimes for the same identity) and keeps the
        recovery history, so a reset cannot buy extra respawns inside the budget window."""
        if self.state.get("creation_uncertain") and not creation_inspected:
            raise ValueError("inspect Reverie for the uncertain creation first, then pass --creation-inspected")
        candidate = self.state.get("candidate")
        if candidate:
            try:
                live = self.api.call("GET", "/api/v1/sessions/" + candidate)
                live = live.get("session", live)
                alive = not live.get("paneExit")
            except urllib.error.HTTPError as error:
                if error.code != 404: raise
                alive = False
            if alive:
                raise ValueError("candidate " + candidate + " is still live: activate it, or close it with Reverie first")
        cleared = {key: self.state.get(key) for key in ("phase", "candidate", "creation_uncertain")}
        self.state.update(phase="running", candidate=None, creation_uncertain=False)
        self.save()
        return {"reset": cleared, "current": self.state.get("current"),
                "recovery_attempts": len(self.state.get("recovery_attempts", []))}

    def identity_report(self):
        """Read-only: where durable identity no longer points at a live session, and who can fix it.

        Uses only GET calls. Each finding names the exact API call that would repair it and
        whose authority that call needs; nothing is changed here."""
        listed = self.api.call("GET", "/api/v1/sessions")
        sessions = listed.get("sessions", listed) if isinstance(listed, dict) else listed
        sessions = [s for s in sessions or [] if isinstance(s, dict) and s.get("id")]
        live = {s["id"]: s for s in sessions if s.get("pid") is not None and not s.get("paneExit")}
        by_name = {}
        for session in live.values():
            by_name.setdefault(session.get("name"), []).append(session["id"])
        findings, actions = [], []
        current = self.state.get("current")
        if current and current not in live:
            matches = [m for m in self.adoption_matches(current) if self.adoptable(m)]
            finding = {"kind": "runtime_not_tracked", "tracked": current, "phase": self.state.get("phase"),
                       "adoptable": [m["id"] for m in matches]}
            findings.append(finding)
            if len(matches) == 1:
                actions.append({"authority": "watcher (runs check, then a verified activate)",
                                "action": "reverie-runtime check; verify the candidate; reverie-runtime activate " + matches[0]["id"]})
        company = self.api.call("GET", "/api/v1/company")
        for employee in company.get("employees", []):
            if employee.get("sessionId") in live: continue
            named = by_name.get(employee.get("name"), [])
            findings.append({"kind": "employee_unbound", "employee": employee.get("id"), "name": employee.get("name"),
                             "bound_to": employee.get("sessionId"), "live_same_name": named})
            if len(named) == 1:
                actions.append({"authority": "owner", "method": "PUT",
                                "path": "/api/v1/company/employees/%s/session" % urllib.parse.quote(str(employee.get("id")), safe=""),
                                "body": {"sessionId": named[0]}})
        stale = [a.get("sessionId") for a in company.get("temporaryAgents", []) if a.get("sessionId") not in live]
        if stale:
            findings.append({"kind": "temporary_agents_stale", "count": len(stale)})
        rooms = self.api.call("GET", "/api/v1/chatrooms")
        rooms = rooms.get("rooms", []) if isinstance(rooms, dict) else rooms
        for room in rooms:
            for member in room.get("members", []):
                if member.get("sessionId") in live: continue
                named = by_name.get(member.get("name"), [])
                findings.append({"kind": "room_member_dead", "room": room.get("name"), "session": member.get("sessionId"),
                                 "name": member.get("name"), "role": member.get("role"), "live_same_name": named})
                if len(named) == 1 and not any(m.get("sessionId") == named[0] for m in room.get("members", [])):
                    actions.append({"authority": "owner" if member.get("role") == "coordinator" else "owner or room coordinator",
                                    "method": "POST", "path": "/api/v1/chatrooms/%s/%s" % (
                                        urllib.parse.quote(str(room.get("id")), safe=""),
                                        "coordinator" if member.get("role") == "coordinator" else "members"),
                                    "body": {"sessionId": named[0]}})
        return {"live_sessions": len(live), "findings": findings, "owner_actions": actions,
                "note": "read-only report; a name match is a lead to verify, not proof of identity"}

    def inside_instances_dir(self, path):
        """The resolved path if it lies strictly inside the policy's instances_dir, else None.

        Agents run as the same user that owns the marker and this policy, so neither is trusted to
        name a file outside the owner's instance configs. Without instances_dir nothing is."""
        if not self.policy.get("instances_dir"): return None
        try: path = Path(path).resolve()
        except (OSError, RuntimeError): return None
        return path if self.resolve(self.policy["instances_dir"]) in path.parents else None

    def instance_for(self, session_id, live):
        """The owner-selected instance config of a session: the supervised runtime's own, else the policy's map.

        A shared working dir is not identity, so the workspace marker counts only for the
        session this controller tracks as current. Either way the config must be inside instances_dir."""
        if session_id == self.state.get("current"):
            workspace = Path(live.get("workingDir") or ".")
            try:
                if not workspace.is_absolute(): raise ValueError("no absolute working dir")
                data = read_regular(workspace / ".reverie-instance", MARKER_BYTES + 1)
                if len(data) > MARKER_BYTES: raise ValueError("marker too large")
                instance = json.loads(data).get("instance")
                named = self.inside_instances_dir(workspace / instance) if isinstance(instance, str) and instance else None
            except (OSError, ValueError, AttributeError): named = None
            if named is not None: return str(named)
        path = self.policy.get("agent_instances", {}).get(session_id)
        named = self.inside_instances_dir(self.resolve(path)) if isinstance(path, str) and path else None
        return str(named) if named is not None else None

    def profile(self, session_id, include_dms=True):
        """Read-only profile of one agent session: backend, model, effort, usage, durable bindings, persona.

        GET calls and local reads only. Backend switching is listed as unavailable: it is an owner
        action and waits for owner authentication. Without include_dms, direct-message rooms are left
        out (the console hides an agent's DMs from other agents, and this report reads as the owner)."""
        if not isinstance(session_id, str) or not SESSION_ID.fullmatch(session_id): raise ValueError("invalid session id")
        try: live = self.api.call("GET", "/api/v1/sessions/" + urllib.parse.quote(session_id, safe=""))
        except urllib.error.HTTPError as error:
            if error.code == 404: return {"error": "no such session", "status": 404}
            raise
        live = live.get("session", live)
        display = live.get("displayModel")
        display = display.get("model") if isinstance(display, dict) else display
        chain = live.get("claudeSessionChain") or ([live["claudeSessionId"]] if live.get("claudeSessionId") else [])
        projects = Path(os.environ.get("CLAUDE_CONFIG_DIR") or Path.home() / ".claude") / "projects"
        tokens = live.get("tokens") if isinstance(live.get("tokens"), dict) else {}
        result = {
            "session": {"id": live.get("id", session_id), "name": live.get("name"), "status": live.get("status"),
                        "alive": live.get("pid") is not None and not live.get("paneExit"),
                        "pinned": bool(live.get("pinned")), "created_at": live.get("createdAt"),
                        "last_activity_at": live.get("lastActivityAt"), "working_dir": live.get("workingDir")},
            "backend": {"mode": live.get("mode"), "model": live.get("model") or display, "display_model": display},
            "effort": {"configured": live.get("effort"),
                       "observed": observed_effort(chain[-1], projects) if live.get("mode") == "claude" and chain else None},
            "usage": {"input_tokens": tokens.get("input", live.get("inputTokens")),
                      "output_tokens": tokens.get("output", live.get("outputTokens")),
                      "total_tokens": tokens.get("total"), "cost": live.get("totalCost"),
                      "messages": live.get("messageCount"),
                      "scope": "console counters for this session since created_at; no per-day history is recorded yet"},
        }
        company = self.api.call("GET", "/api/v1/company")
        employee = next((e for e in company.get("employees", []) if e.get("sessionId") == session_id), None)
        result["employee"] = {key: employee.get(key) for key in ("id", "name", "icon", "position", "expertise")} if employee else None
        rooms = self.api.call("GET", "/api/v1/chatrooms?member=" + urllib.parse.quote(session_id, safe=""))
        rooms = rooms.get("rooms", []) if isinstance(rooms, dict) else rooms
        result["rooms"] = [{"id": room.get("id"), "name": room.get("name"),
                            "role": next((m.get("role") for m in room.get("members", []) if m.get("sessionId") == session_id), None)}
                           for room in rooms if any(m.get("sessionId") == session_id for m in room.get("members", []))
                           and (include_dms or room.get("kind") != "dm")]
        supervised = session_id == self.state.get("current")
        result["runtime"] = {
            "supervised": supervised,
            "backend": self.state.get("backend") if supervised else None,
            "phase": self.state.get("phase") if supervised else None,
            "backends": [{"name": name, "mode": backend.get("mode"), "model": backend.get("model"),
                          "enabled": bool(backend.get("enabled"))}
                         for name, backend in self.policy["backends"].items()] if supervised else [],
            "switch": {"available": False, "reason": "switching a backend is an owner action; it waits for owner authentication"}}
        source = self.instance_for(session_id, live)
        persona = None
        if source:
            try:
                data = read_regular(source, INSTANCE_BYTES + 1)
                if len(data) > INSTANCE_BYTES: raise ValueError("instance config too large")
                instance = parse_instance(data.decode("utf-8"), Path(source))
                persona = {"agent_name": instance.agent_name, "role": instance.role, "kind": instance.kind,
                           "persona": instance.persona[:PERSONA_CHARS], "source": source}
            except (OSError, ValueError):
                persona = {"error": "instance config unreadable", "source": source}
        result["persona"] = persona
        result["note"] = "read-only profile; nothing was changed"
        return result

    def check(self, now=None):
        now = time.time() if now is None else now
        if self.resolve(self.policy["pause_file"]).exists(): return {"paused":True}
        if self.state.get("creation_uncertain"):
            return {"pending":True, "phase":self.state.get("phase", "inspect_uncertain_creation")}
        candidate = self.state.get("candidate")
        if candidate:
            try:
                pending = self.api.call("GET", "/api/v1/sessions/" + candidate)
                pending = pending.get("session", pending)
                dead = bool(pending.get("paneExit"))
            except urllib.error.HTTPError as error:
                if error.code != 404: raise
                dead = True
            if not dead: return {"pending":True, "phase":self.state.get("phase", "awaiting_verified_handoff")}
            self.state["candidate"] = None; self.save()
            text = "candidate " + candidate + " died before activation"
            if self.current_is_live():
                # A failed planned switch: keep supervising the healthy runtime.
                self.state["phase"] = "running"; self.save()
                return dict(self.alert(text + "; still supervising the current runtime"), candidate=candidate)
            return self.needs_owner("candidate_failed", text, candidate=candidate)
        current = self.state.get("current")
        if not current: return {"unconfigured":True}
        if self.state.get("phase") in STOPPED: return {"stopped":True, "phase":self.state["phase"]}
        try: live = self.api.call("GET", "/api/v1/sessions/" + current)
        except urllib.error.HTTPError as error:
            if error.code != 404: raise
            cause = self.disappearance(current)
            if cause == "restart":
                # The container/tmux restarted and Reverie cleaned the dead pane: not an owner stop.
                return self.recover(now, "container_restart")
            # A delete (owner X, guarded CLI or clean-exit sweep) is intentional; no evidence is not a crash.
            self.state["phase"] = "owner_closed" if cause == "deleted" else "missing_needs_owner"; self.save()
            return {"stopped":True, "phase":self.state["phase"]}
        live = live.get("session", live)
        pane_exit = live.get("paneExit")
        capacity_blocked = self.state.get("backend") != self.policy["fallback"] and bool(
            re.search(r"usage limit|rate limit|out of credits|continuing automatically at", live.get("paneDialog") or "", re.I))
        if not pane_exit and not capacity_blocked:
            seen = {"current_name": live.get("name") or self.state.get("current_name"),
                    "current_dir": live.get("workingDir") or self.state.get("current_dir")}
            if (any(self.state.get(key) != value for key, value in seen.items())
                    or now - self.state.get("last_seen_at", 0) >= 30):
                self.state.update(seen, last_seen_at=now); self.save()
            self.remember_bindings(current, now)
            return {"healthy":live.get("pid") is not None,
                    "needs_attention":bool(live.get("paneDialog")) or live.get("pid") is None}
        if pane_exit and self.is_clean_exit(pane_exit):
            self.state["phase"] = "clean_exit"; self.save(); return {"stopped":True, "phase":"clean_exit"}
        return self.recover(now, "capacity_blocked" if not pane_exit else "abnormal_exit")


def poll_interval(policy):
    interval = policy.get("keep_alive", {}).get("poll_seconds", 10)
    if not isinstance(interval, (int, float)) or not 1 <= interval <= 300:
        raise ValueError("keep-alive poll interval must be between 1 and 300 seconds")
    return interval


def heartbeat_path(state_path): return Path(state_path).with_suffix(".heartbeat")


def tick_timeout(policy):
    """Seconds one tick may take before SIGALRM (default action: terminate) ends the watcher."""
    value = policy.get("keep_alive", {}).get("tick_timeout_seconds", 300)
    if not isinstance(value, int) or not 2 <= value <= 3600:
        raise ValueError("tick timeout must be an integer between 2 and 3600 seconds")
    return value


def unfinished_tick(beat, now=None):
    """Seconds a recorded tick ran without finishing, or None when the last tick finished."""
    started, finished = beat.get("tick_started_at"), beat.get("tick_finished_at")
    if not isinstance(started, (int, float)) or (isinstance(finished, (int, float)) and finished >= started): return None
    return round((time.time() if now is None else now) - started, 1)


def watcher_health(runtime, now=None):
    """`ticking`: a watcher holds the lock and completes ticks. `healthy`: its ticks also succeed.

    A supervisor restarts a watcher that is not ticking; restarting cannot fix one whose ticks
    fail (Reverie down, bad policy), so that is reported, not restarted."""
    now = time.time() if now is None else now
    limit = 3 * poll_interval(runtime.policy) + 30
    path = heartbeat_path(runtime.state_path)
    try: age = now - path.stat().st_mtime
    except FileNotFoundError:
        return {"ticking": False, "healthy": False, "reason": "no heartbeat yet", "limit_seconds": limit}
    try: beat = json.loads(path.read_text() or "{}")
    except (OSError, ValueError): beat = {}
    errors = beat.get("consecutive_errors")
    last_ok = beat.get("last_ok_at")
    ticking = age <= limit
    healthy = ticking and errors == 0 and isinstance(last_ok, (int, float)) and now - last_ok <= limit
    return {"ticking": ticking, "healthy": healthy, "heartbeat_age_seconds": round(age, 1), "limit_seconds": limit,
            "consecutive_errors": errors, "last_ok_age_seconds": round(now - last_ok, 1) if last_ok else None,
            "last_error": beat.get("last_error"), "pid": beat.get("pid"),
            "running_tick_seconds": unfinished_tick(beat, now)}


def watch(policy_path, step, ticks=None, sleep=time.sleep, out=print, alarm=signal.alarm):
    """Run `step` forever as the only active watcher; a second one waits as a hot standby.

    The exclusive lock is held for the watcher's lifetime, so a supervisor restarting it,
    or an old instance still running, can never produce two active watchers. Each tick runs
    under SIGALRM with its default action, so a tick hung anywhere (even in C) ends the
    process and frees the lock instead of blocking the standby forever."""
    runtime = Runtime(policy_path)
    lock_path = runtime.state_path.with_suffix(".watch.lock")
    if alarm is signal.alarm: signal.signal(signal.SIGALRM, signal.SIG_DFL)   # default action: terminate
    with lock_path.open("a+") as lock:
        try: fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            out(json.dumps({"standby": "another watcher is active; waiting for its lock"}), flush=True)
            fcntl.flock(lock, fcntl.LOCK_EX)
        lock.seek(0); lock.truncate(); lock.write(str(os.getpid())); lock.flush()   # read by stop-watcher
        previous, count, interval, timeout = None, 0, 10, 300
        try: before = json.loads(heartbeat_path(runtime.state_path).read_text())
        except (OSError, ValueError): before = {}
        before = before if isinstance(before, dict) else {}
        carried_errors = before.get("consecutive_errors") if isinstance(before.get("consecutive_errors"), int) else 0
        beat = {"pid": os.getpid(), "consecutive_errors": carried_errors,   # a restart does not clear failures
                "last_ok_at": before.get("last_ok_at"), "last_error": before.get("last_error")}
        unfinished = unfinished_tick(before)
        if unfinished is not None:
            # An alarm kill writes nothing; the next watcher reports what it was doing.
            beat.update(consecutive_errors=carried_errors + 1,
                        last_error="previous watcher (pid %s) died %ss into a tick; probable tick timeout"
                                   % (before.get("pid"), unfinished))
            atomic_write(heartbeat_path(runtime.state_path), dict(beat, at=time.time()))   # visible before the next tick
        while ticks is None or count < ticks:
            alarm(timeout)
            beat["tick_started_at"] = time.time()
            atomic_write(heartbeat_path(runtime.state_path), dict(beat, at=beat["tick_started_at"]))
            try:
                policy = Runtime(policy_path).policy          # a bad policy is a failed tick, not a crash
                interval, timeout = poll_interval(policy), tick_timeout(policy)
                alarm(timeout)
                result = step()
            except Exception as error:
                result = {"error": str(error)}
            finally:
                alarm(0)
            if "error" in result:
                beat.update(consecutive_errors=beat["consecutive_errors"] + 1, last_error=result["error"][:300])
            else:
                beat.update(consecutive_errors=0, last_ok_at=time.time())
            beat["tick_finished_at"] = time.time()
            atomic_write(heartbeat_path(runtime.state_path), dict(beat, at=beat["tick_finished_at"]))
            encoded = json.dumps(result, sort_keys=True)
            if encoded != previous:
                out(encoded, flush=True); previous = encoded
            count += 1
            sleep(interval)


def is_watcher_argv(args):
    """Exactly `[python] reverie-runtime ... watch` or `python -m reverie.runtime ... watch`, nothing that merely mentions them."""
    if len(args) < 2 or args[-1] != "watch": return False
    program, rest = Path(args[0]).name, args[1:]
    if program.startswith("python"):
        if rest[:2] == ["-m", "reverie.runtime"]: return True
        return bool(rest) and Path(rest[0]).name == "reverie-runtime"
    return program == "reverie-runtime"


def watcher_processes(policy_path, proc=Path("/proc")):
    """Pids of `reverie-runtime ... watch` processes for this policy (active and standby)."""
    policy = str(Path(policy_path).expanduser().resolve())
    found = []
    for entry in proc.iterdir():
        if not entry.name.isdigit() or int(entry.name) == os.getpid(): continue
        try: argv = (entry / "cmdline").read_bytes().split(b"\0")
        except OSError: continue
        args = [part.decode(errors="replace") for part in argv if part]
        if not is_watcher_argv(args): continue
        try: given = args[args.index("--policy") + 1]
        except (ValueError, IndexError): continue
        if str(Path(given).expanduser().resolve()) == policy: found.append(int(entry.name))
    return sorted(found)


def stop_watchers(policy_path, proc=Path("/proc"), kill=os.kill, wait=time.sleep, grace=5):
    """Supervisor stop: end every watcher for this policy (podman exec leaves them running)."""
    pids = watcher_processes(policy_path, proc)
    for pid in pids:
        try: kill(pid, signal.SIGTERM)
        except ProcessLookupError: pass
    if pids: wait(grace)
    survivors = [pid for pid in watcher_processes(policy_path, proc) if pid in pids]
    for pid in survivors:
        try: kill(pid, signal.SIGKILL)
        except ProcessLookupError: pass
    return {"terminated": pids, "killed": survivors}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--policy", type=Path, default=env_names.lookup("REVERIE_RUNTIME_POLICY"))
    sub = parser.add_subparsers(dest="action", required=True)
    sub.add_parser("status"); sub.add_parser("local-health")
    switch = sub.add_parser("switch"); switch.add_argument("backend"); switch.add_argument("--handoff", required=True)
    reboot = sub.add_parser("reboot"); reboot.add_argument("--handoff", required=True)
    activate = sub.add_parser("activate"); activate.add_argument("session_id")
    sub.add_parser("check"); sub.add_parser("watch")
    sub.add_parser("identity", help="read-only report of stale identity bindings and the calls that repair them")
    profile = sub.add_parser("profile", help="read-only profile of one agent session (backend, model, effort, usage, persona)")
    profile.add_argument("session_id")
    profile.add_argument("--no-dms", action="store_true", help="leave out direct-message rooms (for a non-owner caller)")
    health = sub.add_parser("watcher-health", help="exit 1 when no watcher is ticking (or, with --healthy, failing)")
    health.add_argument("--healthy", action="store_true", help="also require its ticks to succeed")
    sub.add_parser("stop-watcher", help="supervisor: terminate this policy's watchers (active and standby)")
    restore = sub.add_parser("restore-bindings"); restore.add_argument("session_id")
    reset = sub.add_parser("reset", help="owner: leave a stopped phase and resume supervising the current runtime")
    reset.add_argument("--creation-inspected", action="store_true")
    args = parser.parse_args(argv)
    if not args.policy: parser.error("select an external runtime policy")
    runtime = Runtime(args.policy)
    lock_path = runtime.state_path.with_suffix(".lock")
    lock_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    with lock_path.open("a") as lock:
        def step():
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            try:
                current = Runtime(args.policy)
                if args.action == "status": return dict(current.state, watcher=watcher_health(current))
                if args.action == "identity":
                    try: return current.identity_report()
                    except (OSError, RuntimeError, ValueError) as error:   # console down or refusing: report, not a traceback
                        return {"error": str(error)}
                if args.action == "local-health": return current.local_health()
                if args.action == "switch": return current.start(args.backend, args.handoff)
                if args.action == "reboot": return current.start(current.state.get("backend",current.policy["fallback"]), args.handoff)
                if args.action == "activate": return current.activate(args.session_id)
                if args.action == "reset": return current.reset(args.creation_inspected)
                if args.action == "restore-bindings":
                    if args.session_id != current.state.get("current"): raise ValueError("not the active runtime")
                    return current.restore_bindings(args.session_id)
                return current.check()
            finally:
                fcntl.flock(lock, fcntl.LOCK_UN)
        if args.action == "watch":
            watch(args.policy, step)
        elif args.action == "watcher-health":
            health = watcher_health(runtime)
            print(json.dumps(health))
            return 0 if health["healthy" if args.healthy else "ticking"] else 1
        elif args.action == "stop-watcher":
            print(json.dumps(stop_watchers(args.policy)))
        elif args.action == "profile":
            # Read-only and called per console click: never waits on, or blocks, the watcher's lock.
            try: result = runtime.profile(args.session_id, include_dms=not args.no_dms)
            except (OSError, RuntimeError, ValueError) as error: result = {"error": str(error)}
            print(json.dumps(result, indent=2))
            return 1 if "error" in result else 0
        else:
            print(json.dumps(step(), indent=2))
    return 0

if __name__ == "__main__": raise SystemExit(main())
