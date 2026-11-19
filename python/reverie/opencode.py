"""JSON stdin bridge for the OpenCode plugin; no daemon, polling or reply generation."""
from __future__ import annotations

import os
import json
import re
from pathlib import Path
import sys
import time
import subprocess
import urllib.parse
import urllib.request

from .reverie import Reverie, native_context, violates
from .persona import build_system_prompt
from .hands.agent_journal import native_memory_json
from .instance import initial_self_for, identity_context, primary_agent
from reverie import env_names


def active_mode(brain) -> str:
    """The primary session's interaction mode, "coding" or "chat", from its interaction state; "chat" when unknown."""
    try:
        runtime = json.loads(brain.store.get_state("reverie_runtime") or "{}")
        session, directory = str(runtime.get("session_id", "")), str(runtime.get("directory", ""))
        if not directory or not re.fullmatch(r"[A-Za-z0-9_-]{1,160}", session):
            return "chat"
        state = json.loads((Path(directory) / ".opencode" / "interaction-state" / (session + ".json")).read_text())
        return "coding" if isinstance(state, dict) and state.get("mode") == "coding" else "chat"
    except (OSError, ValueError, AttributeError, TypeError):
        return "chat"


def social_room(instance, mode: str) -> bool:
    return getattr(instance, "shared_room_tone", "professional") == "social" and mode != "coding"


def office_journal(request):
    unconfirmed = ("journal save was not confirmed; inspect the journal before another save"
                   if request["action"] == "remember" else "journal lookup was not confirmed")
    try:
        result = subprocess.run(["reverie-memory-journal", "--journal-only"], input=json.dumps(request),
                                capture_output=True, encoding="utf-8", check=False)
    except OSError as error:
        raise RuntimeError("the packaged Office journal client is unavailable") from error
    if result.returncode:
        try:
            reason = json.loads(result.stderr.splitlines()[-1])["error"]
        except (IndexError, KeyError, TypeError, ValueError):
            reason = unconfirmed
        raise RuntimeError(reason)
    try:
        return json.loads(result.stdout)
    except ValueError as error:
        raise RuntimeError(unconfirmed) from error


def remember_on_office(request):
    # The Office checks the actual room and source for saves.
    fields = ("text", "project", "room", "turn", "tag", "quote", "source", "reason")
    return office_journal({"action": "remember", "private": not request.get("project"),
                           **{key: request[key] for key in fields if key in request}})


def dispatch(brain, request: dict):
    action = request.get("action", "context")
    if action == "remember":
        return remember_on_office(request)
    reverie = Reverie(brain.store, initial_self_for(brain.cfg.instance))
    if action == "context":
        query = str(request.get("query", "reverie priorities plans decisions"))
        messages, _ = brain.build_messages(query, recall_long_term=False)
        work = request.get("channel", "private") == "work"
        self_model = reverie.self_model()["body"]
        if work:
            messages = [{"role": "system", "content": build_system_prompt(
                self_model["persona"], "", [])}]
        mode = reverie.read("lifecycle", {"mode": "active"})["body"]
        return native_context("context", {
            "identity": identity_context(brain.cfg.instance), "role": getattr(brain.cfg.instance, "role", "Expert"),
            "system": messages[0]["content"], "plan": reverie.plan()["body"],
            "self_model": {key: self_model[key] for key in ("consciousness", "directives")},
            "social_room": social_room(brain.cfg.instance, active_mode(brain)) if work else None,
            "vacation": mode["mode"] == "vacation", "messages": messages[1:-1],
            "limits": {"window": int(request.get("context_window", 16384)),
                       "output": int(request.get("output_tokens", 4096)),
                       "occupied": int(request.get("occupied_tokens", 0))},
        })

    if action == "mode":
        return reverie.read("lifecycle", {"mode": "active"})["body"]
    if action == "rules":
        return native_context("rules", None)
    if action == "votes":
        return reverie.ballot_history()
    if action == "self_history":
        with brain.store._lock:
            return [dict(row) for row in brain.store._db.execute(
                "SELECT * FROM reverie_document_history WHERE name='self' ORDER BY revision DESC")]
    if action == "self_vote":
        model = request["model"]
        if not isinstance(model, dict) or not isinstance(model.get("consciousness"), str) or not isinstance(
                model.get("directives"), list) or any(not isinstance(x, str) or not x.strip() or len(x) > 2000
                                                     for x in model["directives"]):
            raise ValueError("core proposal needs consciousness and a list of directive statements")
        proposal = {key: model[key] for key in ("consciousness", "directives")}
        ballot = reverie.vote("core", proposal, request["reason"])
        if ballot["approved"]:
            current = reverie.self_model()
            if any(current["body"].get(key) != proposal[key] for key in proposal):
                reverie.save_self({**current["body"], **proposal}, request["reason"], current["revision"], core_approved=True)
        return {"ballot": ballot, "self": reverie.self_model()}
    if action == "publication_proposal":
        proposal = request["proposal"]
        if not isinstance(proposal, str) or not proposal.strip():
            raise ValueError("describe the exact publication scope, excluded private history and review requirements")
        ballot = reverie.vote("publication", {"scope": proposal, "automatic_upload": False}, request["reason"])
        if ballot["approved"]:
            current = reverie.read("publication_request")
            reverie.write("publication_request", {"proposal": proposal, "status": "owner_review_required",
                        "votes": ballot, "automatic_upload": False}, current["revision"])
        return {"ballot": ballot, "next_action": "Ask the owner to review the concrete publication package" if
                ballot["approved"] else "Reconsider explicitly in the next UTC calendar week; no upload is authorized"}
    if action == "return":
        # Exposed only through the plugin's owner-confirmed return action.
        current = reverie.read("lifecycle", {"mode": "active"})
        return reverie.write("lifecycle", {"mode": "active", "needs_handoff": True,
                           "next_action": "Read current reverie state and obtain owners' handoffs before taking work"},
                           current["revision"])
    if action == "activity":
        if request.get("research_cycle_id") or env_names.lookup("REVERIE_RESEARCH_CYCLE_ID"):
            return {"ok": True, "research": True}
        brain.store.set_state("reverie_last_activity", str(time.time()))
        runtime = request.get("runtime")
        if runtime is not None:
            endpoint = urllib.parse.urlparse(runtime["url"])
            if endpoint.scheme != "http" or endpoint.hostname not in ("127.0.0.1", "localhost", "::1"):
                raise ValueError("OpenCode runtime must use a local HTTP endpoint")
            if endpoint.username or endpoint.password or not runtime.get("session_id"):
                raise ValueError("invalid OpenCode runtime")
            brain.store.set_state("reverie_runtime", json.dumps(runtime))
        return {"ok": True}
    if action == "record":
        source = str(request.get("source_id", ""))
        user, reply = str(request.get("user", "")), str(request.get("reply", ""))
        if not user.strip() or not reply.strip():
            raise ValueError("a completed turn requires input and reply")
        if violates(reply):
            raise ValueError("reply crossed a hard floor")
        memory = brain.store.add_external_episode(source, user, reply, request.get("visibility", "private"))
        brain.store.set_state("reverie_last_activity", str(time.time()))
        return {"memory_id": memory.id}
    if action == "plan":
        if "text" in request:
            text = request["text"]
            if not isinstance(text, str) or not text.strip():
                raise ValueError("plan must be nonempty text")
            return reverie.write("plan", text, int(request["revision"]))
        return reverie.plan()
    if action == "profiles":
        return reverie.profiles()
    if action == "self":
        if "model" in request:
            return reverie.save_self(request["model"], request["reason"], int(request["revision"]))
        return reverie.self_model()
    if action == "profile":
        return reverie.save_profile(request["name"], request["profile"], int(request["revision"]))
    if action == "brief":
        return reverie.brief(request["names"], request["task"], int(request.get("budget", 12000)),
                           context=request.get("context"), context_window=request.get("context_window"),
                           output_tokens=request.get("output_tokens", 4096),
                           occupied_tokens=request.get("occupied_tokens", 0))
    raise ValueError(f"unknown bridge action {action}")


def voice_reply(brain, transcript: str) -> tuple[bool, str | None]:
    """Route voice through the same tool-using CTO session after runtime activation.

    A stale runtime fails visibly; it never silently switches to a second persona.
    The existing in-process voice path remains available before OpenCode is activated.
    """
    raw = brain.store.get_state("reverie_runtime")
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
def install(workspace: Path, model: str, instance_config: Path | None = None,
            api_base: str | None = None, context_window: int = 32768,
            output_tokens: int = 4096, api_key_env: str | None = None) -> dict:
    """Compatibility caller for the native workspace installer."""
    request = {
        "install": {"install": str(workspace), "model": model,
                    "instance": str(instance_config) if instance_config else None,
                    "api_base": api_base, "context_window": context_window,
                    "output_tokens": output_tokens, "api_key_env": api_key_env},
    }
    result = native_memory_json("opencode-install-worker", request, 32768, timeout=30)
    if result is None:
        raise RuntimeError("the packaged OpenCode installer is unavailable")
    if "error" in result:
        raise ValueError(result["error"])
    return result


def native_state(request, instance=None, *, capture_output=False):
    command = ["reverie-opencode", "--bridge"]
    if instance:
        command.extend(("--instance", str(instance)))
    return subprocess.run(command, input=json.dumps(request), encoding="utf-8",
                          timeout=120 if request.get("action") == "maintenance" else 60,
                          check=False, capture_output=capture_output)


if __name__ == "__main__":
    # Older source-installed OpenCode plugins invoked this module directly.
    try:
        os.execvp("reverie-opencode", ["reverie-opencode", *sys.argv[1:]])
    except OSError as error:
        print(json.dumps({"error": str(error)}), file=sys.stderr)
        sys.exit(1)
