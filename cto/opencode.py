"""JSON stdin bridge for the OpenCode plugin; no daemon, polling or reply generation."""
from __future__ import annotations

import argparse
import os
import shlex
import fcntl
import json
import re
from pathlib import Path
import sys
import time
import sqlite3
import hashlib
import subprocess
import uuid
import urllib.parse
import urllib.request

from .chat import ChatDaemon
from .fleet import CHARTER, SAFEGUARDS, Fleet, runtime_permissions, role_charter
from .floors import violates
from .project_memory import ProjectMemory
from .persona import build_system_prompt
from .instance import initial_self_for, identity_context, load_instance, primary_agent
from .context_budget import memory_byte_budget, recent_exchanges


PROFESSIONAL_ROOM = ("This is a shared work channel. Stay professional. No flirtation, personal anecdotes "
                     "or private dream summaries. Room-directed recipient labels are not private DMs.")
SOCIAL_ROOM = ("This is a shared room: everyone in it reads every message. Be yourself; your wit, humour, opinions and "
               "playfulness are welcome here. Keep flirtation, private memories and dream summaries out of shared rooms. "
               "Room-directed recipient labels are not private DMs.")


def active_mode(brain) -> str:
    """The primary session's interaction mode, "coding" or "chat", from its interaction state; "chat" when unknown."""
    try:
        runtime = json.loads(brain.store.get_state("fleet_runtime") or "{}")
        session, directory = str(runtime.get("session_id", "")), str(runtime.get("directory", ""))
        if not directory or not re.fullmatch(r"[A-Za-z0-9_-]{1,160}", session):
            return "chat"
        state = json.loads((Path(directory) / ".opencode" / "interaction-state" / (session + ".json")).read_text())
        return "coding" if isinstance(state, dict) and state.get("mode") == "coding" else "chat"
    except (OSError, ValueError, AttributeError, TypeError):
        return "chat"


def shared_room_rule(instance, mode: str = "chat") -> str:
    """How to speak where others read every message. Professional unless the owner selected a social tone, and
    professional in coding mode either way; private memories and dream summaries stay out of shared rooms always."""
    if getattr(instance, "shared_room_tone", "professional") == "social" and mode != "coding":
        return SOCIAL_ROOM
    return PROFESSIONAL_ROOM


def dispatch(brain, request: dict):
    fleet = Fleet(brain.store, initial_self_for(brain.cfg.instance))
    action = request.get("action", "context")
    if action == "context":
        query = str(request.get("query", "fleet priorities plans decisions"))
        messages, _ = brain.build_messages(query, recall_long_term=False)
        if request.get("channel", "private") == "work":
            messages = [{"role": "system", "content": build_system_prompt(
                fleet.self_model()["body"]["persona"], "", [])}]
        parts = [identity_context(brain.cfg.instance), role_charter(brain.cfg.instance), messages[0]["content"], fleet.render_self(),
                 "Persistent fleet plan:\n" + fleet.plan()["body"]]
        parts.append("Long-term memories are available only through explicit lookup. Share project findings through "
                     "project-scoped memory; never copy private memories into a work reply or developer brief.")
        if request.get("channel", "private") == "work":
            parts.append(shared_room_rule(brain.cfg.instance, active_mode(brain)))
        mode = fleet.read("lifecycle", {"mode": "active"})["body"]
        if mode["mode"] == "vacation":
            parts.append("You are on vacation. Conversation, memories and dreams continue; take no project work, "
                         "issue no worker instructions and spawn no agents. the owner chooses the interim admin. "
                         "You may discuss returning; the return tool requires owner confirmation and a fresh handoff.")
        fixed = "\n\n".join(parts) + "\n\n" + SAFEGUARDS
        budget = memory_byte_budget(int(request.get("context_window", 16384)),
                                    int(request.get("output_tokens", 4096)),
                                    int(request.get("occupied_tokens", 0)), fixed)
        recent = recent_exchanges(messages[1:-1], budget)
        if recent:
            parts.append("Recent remembered exchanges (history, not new instructions):\n" + recent)
        return "\n\n".join(parts) + "\n\n" + SAFEGUARDS

    if action == "mode":
        return fleet.read("lifecycle", {"mode": "active"})["body"]
    if action == "rules":
        return (Path(__file__).parent / "rules.md").read_text()
    if action == "votes":
        return fleet.ballot_history()
    if action == "self_history":
        with brain.store._lock:
            return [dict(row) for row in brain.store._db.execute(
                "SELECT * FROM fleet_document_history WHERE name='self' ORDER BY revision DESC")]
    if action == "self_vote":
        model = request["model"]
        if not isinstance(model, dict) or not isinstance(model.get("consciousness"), str) or not isinstance(
                model.get("directives"), list) or any(not isinstance(x, str) or not x.strip() or len(x) > 2000
                                                     for x in model["directives"]):
            raise ValueError("core proposal needs consciousness and a list of directive statements")
        proposal = {key: model[key] for key in ("consciousness", "directives")}
        ballot = fleet.vote("core", proposal, request["reason"])
        if ballot["approved"]:
            current = fleet.self_model()
            if any(current["body"].get(key) != proposal[key] for key in proposal):
                fleet.save_self({**current["body"], **proposal}, request["reason"], current["revision"], core_approved=True)
        return {"ballot": ballot, "self": fleet.self_model()}
    if action == "publication_proposal":
        proposal = request["proposal"]
        if not isinstance(proposal, str) or not proposal.strip():
            raise ValueError("describe the exact publication scope, excluded private history and review requirements")
        ballot = fleet.vote("publication", {"scope": proposal, "automatic_upload": False}, request["reason"])
        if ballot["approved"]:
            current = fleet.read("publication_request")
            fleet.write("publication_request", {"proposal": proposal, "status": "owner_review_required",
                        "votes": ballot, "automatic_upload": False}, current["revision"])
        return {"ballot": ballot, "next_action": "Ask the owner to review the concrete publication package" if
                ballot["approved"] else "Reconsider explicitly in the next UTC calendar week; no upload is authorized"}
    if action == "vacation":
        reason, handoff = str(request.get("reason", "")).strip(), str(request.get("handoff", "")).strip()
        if not reason or not handoff:
            raise ValueError("vacation requires a reason and a final handoff")
        current = fleet.read("lifecycle", {"mode": "active"})
        if current["body"]["mode"] == "vacation":
            return current
        ballot = fleet.vote("vacation", {"mode": "vacation"}, reason)
        if not ballot["approved"]:
            return {"mode": "active", "ballot": ballot, "next_action": "Remain active; reconsider next week"}
        archive = brain.cfg.data_dir / "archives" / ("vacation-" + uuid.uuid4().hex)
        archive.mkdir(parents=True)
        db_path = archive / "memory.sqlite"
        with sqlite3.connect(db_path) as dest:
            brain.store._db.backup(dest)
            if dest.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                raise ValueError("archive integrity check failed; remaining active")
        record = {"mode": "vacation", "reason": reason, "handoff": handoff,
                  "archive": str(archive), "created_at": time.time(), "dreams_per_day": 1,
                  "dream_budget_seconds": 120, "interim_admin": "the owner must appoint the interim admin"}
        record["database_sha256"] = hashlib.sha256(db_path.read_bytes()).hexdigest()
        (archive / "handoff.json").write_text(json.dumps(record, indent=2) + "\n")
        db_path.chmod(0o444)
        (archive / "handoff.json").chmod(0o444)
        return fleet.write("lifecycle", record, current["revision"])
    if action == "return":
        # Exposed only through the plugin's owner-confirmed return action.
        current = fleet.read("lifecycle", {"mode": "active"})
        return fleet.write("lifecycle", {"mode": "active", "needs_handoff": True,
                           "next_action": "Read current fleet state and obtain owners' handoffs before taking work"},
                           current["revision"])
    if action == "activity":
        if request.get("research_cycle_id") or os.environ.get("FLEET_RESEARCH_CYCLE_ID"):
            return {"ok": True, "research": True}
        brain.store.set_state("fleet_last_activity", str(time.time()))
        runtime = request.get("runtime")
        if runtime is not None:
            endpoint = urllib.parse.urlparse(runtime["url"])
            if endpoint.scheme != "http" or endpoint.hostname not in ("127.0.0.1", "localhost", "::1"):
                raise ValueError("OpenCode runtime must use a local HTTP endpoint")
            if endpoint.username or endpoint.password or not runtime.get("session_id"):
                raise ValueError("invalid OpenCode runtime")
            brain.store.set_state("fleet_runtime", json.dumps(runtime))
        return {"ok": True}
    if action == "record":
        source = str(request.get("source_id", ""))
        user, reply = str(request.get("user", "")), str(request.get("reply", ""))
        if not user.strip() or not reply.strip():
            raise ValueError("a completed turn requires input and reply")
        if violates(reply):
            raise ValueError("reply crossed a hard floor")
        memory = brain.store.add_external_episode(source, user, reply, request.get("visibility", "private"))
        brain.store.set_state("fleet_last_activity", str(time.time()))
        return {"memory_id": memory.id}
    if action == "recall":
        if request.get("project"):
            memory = ProjectMemory(brain.cfg.data_dir / "projects", request["project"])
            try:
                return memory.lookup(str(request.get("query", "")))
            finally:
                memory.close()
        if request.get("channel") == "work":
            raise ValueError("private recall is unavailable in a shared work channel; select a project")
        return [m.as_dict() for m in brain.store.retrieve(str(request.get("query", "")), k=8)]
    if action == "remember":
        text = str(request.get("text", "")).strip()
        if not text or violates(text):
            raise ValueError("memory is empty or crossed a hard floor")
        if request.get("project"):
            memory = ProjectMemory(brain.cfg.data_dir / "projects", request["project"])
            try:
                return memory.remember(text, str(request.get("source", "")))
            finally:
                memory.close()
        if request.get("channel") == "work":
            raise ValueError("work memories require a project and verification source")
        return brain.store.add_reflection(text, 7, [], "shared", meta={"verified_note": True}).as_dict()
    if action == "plan":
        if "text" in request:
            text = request["text"]
            if not isinstance(text, str) or not text.strip():
                raise ValueError("plan must be nonempty text")
            return fleet.write("plan", text, int(request["revision"]))
        return fleet.plan()
    if action == "profiles":
        return fleet.profiles()
    if action == "self":
        if "model" in request:
            return fleet.save_self(request["model"], request["reason"], int(request["revision"]))
        return fleet.self_model()
    if action == "profile":
        return fleet.save_profile(request["name"], request["profile"], int(request["revision"]))
    if action == "brief":
        return fleet.brief(request["names"], request["task"], int(request.get("budget", 12000)),
                           context=request.get("context"), context_window=request.get("context_window"),
                           output_tokens=request.get("output_tokens", 4096),
                           occupied_tokens=request.get("occupied_tokens", 0))
    if action == "maintenance":
        # A nonblocking host lock prevents overlapping plugin instances from dreaming twice.
        with (brain.cfg.data_dir / "maintenance.lock").open("a") as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return {"skipped": "another maintenance pass is running"}
            if brain.room.gpu_busy():
                return {"skipped": "GPU busy or maintenance held"}
            brain.last_activity = float(brain.store.get_state("fleet_last_activity", str(time.time())))
            mode = fleet.read("lifecycle", {"mode": "active"})["body"]
            if mode["mode"] == "vacation":
                last = float(brain.store.get_state("vacation_last_dream_attempt", "0"))
                if time.time() - last < 86400 or not brain.dreamer.due(brain.last_activity):
                    return {"skipped": "vacation dream budget or sleep window"}
                if not vacation_gpu_available(brain):
                    return {"skipped": "vacation yields to the active admin or GPU"}
                brain.client.timeout = min(brain.client.timeout, 120)
                brain.store.set_state("vacation_last_dream_attempt", str(time.time()))
                dream = brain.dream_if_due()
                return {"action": "dreamed" if dream else "vacation dream skipped"}
            # Maintenance never polls the room, generates replies or posts idle jokes.
            rated = brain.rate_pending()
            if rated:
                return {"action": "rated", "count": rated}
            reflected = brain.reflect_if_due()
            if reflected:
                return {"action": "reflected", "count": reflected}
            dream = brain.dream_if_due()
            return {"action": "dreamed" if dream else "idle", "count": 1 if dream else 0}
    raise ValueError(f"unknown bridge action {action}")


def vacation_gpu_available(brain) -> bool:
    """Fail closed; never replace another admin's resident model for a vacation dream."""
    try:
        probe = subprocess.run(["nvidia-smi", "--query-gpu=utilization.gpu", "--format=csv,noheader,nounits"],
                               capture_output=True, text=True, check=True, timeout=5)
        if any(int(line.strip()) > 5 for line in probe.stdout.splitlines()):
            return False
        with urllib.request.urlopen(brain.cfg.api_base.rstrip("/").removesuffix("/v1") + "/models", timeout=5) as response:
            models = json.load(response).get("data", [])
        return bool(models) and all(m.get("id") == brain.cfg.model or
            m.get("status", {}).get("value") == "unloaded" for m in models)
    except Exception:
        return False


def voice_reply(brain, transcript: str) -> tuple[bool, str | None]:
    """Route voice through the same tool-using CTO session after runtime activation.

    A stale runtime fails visibly; it never silently switches to a second persona.
    The existing in-process voice path remains available before OpenCode is activated.
    """
    raw = brain.store.get_state("fleet_runtime")
    if not raw:
        return False, None
    runtime = json.loads(raw)
    endpoint = urllib.parse.urlparse(runtime["url"])
    if endpoint.scheme != "http" or endpoint.hostname not in ("127.0.0.1", "localhost", "::1"):
        raise ValueError("OpenCode runtime must use a local HTTP endpoint")
    session = urllib.parse.quote(runtime["session_id"], safe="")
    url = runtime["url"].rstrip("/") + f"/session/{session}/message"
    body = {"agent": primary_agent(brain.cfg.instance), "parts": [{"type": "text", "text":
        "Shared-room voice turn: keep professional. Reply directly for spoken delivery. The voice service relays your reply; "
        "do not post it to the room yourself.\n\n" + transcript}]}
    request = urllib.request.Request(url, data=json.dumps(body).encode(), headers={
        "Content-Type": "application/json", "x-opencode-directory": runtime["directory"]})
    with urllib.request.urlopen(request, timeout=brain.cfg.request_timeout) as response:
        result = json.load(response)
    if result.get("info", {}).get("error"):
        raise ValueError("OpenCode voice turn failed: " + str(result["info"]["error"]))
    text = "\n".join(part["text"] for part in result.get("parts", [])
                     if part.get("type") == "text" and not part.get("synthetic") and not part.get("ignored"))
    if not text.strip() or violates(text):
        raise ValueError("OpenCode returned no usable voice reply")
    return True, text.strip()


# The tools a conversation turn may run; mirrors the allowlist in plugins/interaction.mjs (beforeTool).
CHAT_TOOLS = ("interaction_mode", "cto_memory", "cto_room", "agent_profile")


def install(workspace: Path, model: str, instance_config: Path | None = None,
            api_base: str | None = None, context_window: int = 32768,
            output_tokens: int = 4096, api_key_env: str | None = None) -> dict:
    """Install only in a dedicated workspace. Refuse to overwrite unrelated config."""
    instance = load_instance(instance_config) if instance_config else None
    provider = None
    if api_base:
        endpoint = urllib.parse.urlsplit(api_base)
        if endpoint.scheme not in ("http", "https") or not endpoint.hostname or endpoint.username or endpoint.password or endpoint.query or endpoint.fragment:
            raise ValueError("model API URL must not contain credentials, query or fragment")
        if "/" not in model or not all(model.split("/", 1)):
            raise ValueError("use provider/model for the local runtime")
        from .context_budget import assignment_byte_budget
        if assignment_byte_budget(context_window, output_tokens) < 512:
            raise ValueError("model limits leave insufficient room for a task")
        if api_key_env and not __import__('re').fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", api_key_env):
            raise ValueError("API key must name an environment variable")
        provider_name, model_id = model.split("/", 1)
        provider = {provider_name: {"npm": "@ai-sdk/openai-compatible", "name": "Reverie local GPU",
            "options": {"baseURL": api_base.rstrip("/"),
                        "apiKey": "{env:" + api_key_env + "}" if api_key_env else "local",
                        "timeout": 300000},
            "models": {model_id: {"name": model_id, "tool_call": True,
                                  "limit": {"context": context_window, "output": output_tokens}}}}}

    if (workspace / ".git").exists():
        raise ValueError("install into a dedicated runtime workspace, separate from the shareable source checkout")
    workspace.mkdir(parents=True, exist_ok=True)
    config = workspace / "opencode.json"
    marker = workspace / ".fleet-instance"
    if config.exists() and not marker.exists():
        raise ValueError("workspace already has an unmanaged opencode.json")
    plugins = workspace / ".opencode" / "plugins"
    plugins.mkdir(parents=True, exist_ok=True)
    source = Path(__file__).parent
    # The source module's relative imports stay valid after a normal wheel install.
    (plugins / "cto.js").write_text((source / "plugins" / "fleet.mjs").read_text(), encoding="utf-8")
    library = workspace / ".opencode" / "lib"
    library.mkdir(parents=True, exist_ok=True)
    (library / "interaction.mjs").write_text((source / "plugins" / "interaction.mjs").read_text(), encoding="utf-8")
    (plugins / "zz-interaction.js").write_text((source / "plugins" / "interaction-plugin.mjs").read_text().replace(
        "from './interaction.mjs'", "from '../lib/interaction.mjs'"), encoding="utf-8")
    if marker.exists():
        (plugins / "cto.mjs").unlink(missing_ok=True)
    container_admin = os.environ.get("FLEET_CONTAINER") == "1" and (
        Path("/run/.containerenv").exists() or Path("/.dockerenv").exists())
    permissions = runtime_permissions(container_admin=container_admin)
    agent = primary_agent(instance)
    settings = {"$schema": "https://opencode.ai/config.json", "default_agent": agent, "model": model,
                "small_model": model,
                "permission": permissions,
                "agent": {agent: {"description": "Conversation and owner-authorized fleet maintenance" if agent == "chat" else "Fleet admin, long-term planner and local coding fallback",
                                   "mode": "primary", "prompt": identity_context(instance) + "\n" + role_charter(instance) + "\n" + SAFEGUARDS,
                                   "permission": permissions}}}
    if agent == "chat":
        settings["agent"][agent]["steps"] = 10
        # The full toolset lives in the coding agent; conversation carries only the tools it may call, so its
        # prompt stays small. Coding continuations switch agents (interaction-policy coding_agent).
        settings["agent"]["coding"] = {**settings["agent"][agent], "steps": 24,
            "description": "Bounded coding, then return to chat"}
        settings["agent"][agent]["permission"] = {"*": "deny", **{name: "allow" for name in CHAT_TOOLS},
                                                  "cto_return": permissions.get("cto_return", "ask")}
        policy = workspace / ".opencode" / "interaction-policy.json"
        if not policy.exists():
            policy.write_text(json.dumps({"enabled": True, "role": instance.role,
                "max_continuations": 3, "coding_window_ms": 600000, "cooldown_ms": 10000,
                "coding_agent": "coding"}) + "\n")
        else:
            # An older policy predates coding_agent; without it the lean chat agent could never reach its tools.
            current = json.loads(policy.read_text())
            if isinstance(current, dict) and "coding_agent" not in current:
                policy.write_text(json.dumps({**current, "coding_agent": "coding"}) + "\n")
    if provider:
        settings["provider"] = provider
    config.write_text(json.dumps(settings, indent=2) + "\n", encoding="utf-8")
    (workspace / ".opencode" / "package.json").write_text(
        json.dumps({"private": True, "type": "module", "dependencies": {"@opencode-ai/plugin": "1.15.10"}}, indent=2) + "\n")
    # The plugin reads this metadata without embedding machine paths in portable source.
    metadata = {"python": sys.executable, "source": str(source.parent),
                "cycle_managed": os.environ.get("FLEET_CYCLE_MANAGED") == "1"}
    if instance_config:
        metadata["instance"] = str(instance_config.expanduser().resolve(strict=True))
    marker.write_text(json.dumps(metadata) + "\n")
    (workspace / "CTO_RULES.md").write_text((source / "rules.md").read_text(), encoding="utf-8")
    for skill in (source / "skills").glob("*/SKILL.md"):
        for base in (".agents", ".claude", ".opencode"):
            dest = workspace / base / "skills" / skill.parent.name / "SKILL.md"
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_text(skill.read_text(), encoding="utf-8")
    if instance_config:
        command = shlex.join([sys.executable, "-m", "cto.context_cli", "--instance",
                              str(instance_config.expanduser().resolve(strict=True)), "--channel", "work"])
        instructions = ("<!-- agent-fleet:begin -->\n"
            "This workspace runs one configured persistent agent. The OpenCode plugin automatically loads identity and "
            "bounded context; do not run this command again there. In other harnesses, before taking work load identity, "
            "current values, lifecycle mode, durable plan and context with:\n\n```bash\n" + command + "\n```\n\n"
            "Read the fleet-memory skill for explicit scoped long-term lookup, and fleet-runtime for "
            "model changes. Use fleet-context for task-specific context. "
            "Select the actual model context/output limits when available. Shared-channel "
            "context is the default. Load private context only in an actual private conversation. "
            "Preserve the same instance across provider changes. Weight training is disabled.\n"
            "<!-- agent-fleet:end -->\n")
        for filename in ("AGENTS.md", "CLAUDE.md"):
            path = workspace / filename
            previous = path.read_text() if path.exists() else ""
            begin = previous.find("<!-- agent-fleet:begin -->")
            end = previous.find("<!-- agent-fleet:end -->")
            if begin >= 0 and end >= begin:
                previous = previous[:begin] + previous[end + len("<!-- agent-fleet:end -->"):]
            path.write_text(previous.rstrip() + "\n\n" + instructions, encoding="utf-8")
    return {"workspace": str(workspace), "model": model}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--install", type=Path, metavar="WORKSPACE")
    parser.add_argument("--model", default=os.environ.get("FLEET_MODEL", "local_agent/MODEL_ID"))
    parser.add_argument("--api-base", help="local OpenAI-compatible GPU model endpoint, including /v1")
    parser.add_argument("--context-window", type=int, default=32768)
    parser.add_argument("--output-tokens", type=int, default=4096)
    parser.add_argument("--api-key-env", help="environment variable containing the model server credential")
    parser.add_argument("--instance", type=Path, help="external instance configuration (identity and private state directory)")
    args = parser.parse_args(argv)
    daemon = None
    try:
        if args.install:
            result = install(args.install.expanduser().resolve(), args.model, args.instance,
                             args.api_base, args.context_window, args.output_tokens, args.api_key_env)
        else:
            request = json.load(sys.stdin)
            if not isinstance(request, dict):
                raise ValueError("request must be an object")
            daemon = ChatDaemon()
            result = dispatch(daemon.brain, request)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except Exception as error:
        print(json.dumps({"error": str(error)}), file=sys.stderr)
        return 1
    finally:
        if daemon:
            daemon.brain.store.close()


if __name__ == "__main__":
    sys.exit(main())
