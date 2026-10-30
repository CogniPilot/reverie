"""reverie-memory remember and recall, carried by the office journal (`reverie agent journal ... --json`).

The journal is the store of record: it lives on the office server, so it outlives a runtime or model switch. This
module only builds argument lists for the agent's own `reverie` CLI, which proves who the caller is from inside its
session; it adds no credential of its own.

A save is tied to the message the agent is acting on. The room and turn always come from the caller and are never
guessed (say from the latest message in a room): a guessed turn would quietly defeat the journal's readable-turn gate.
Without them, remember refuses and prints the exact `reverie agent journal save` command to run instead; it never runs
that command itself.
"""
from __future__ import annotations

import json
import os
import shlex
import shutil
import subprocess
from typing import Callable

from reverie import env_names

TAGS = ("decision", "promise", "correction", "preference", "identity", "relationship", "open-question", "lesson",
        "personal-reflection")
TIMEOUT_S = 60
# Said with every save that could not reach the journal, so the agent does not assume it survives a backend switch.
LOCAL_ONLY = ("saved to the old local store only, not to your office journal: it will not follow a runtime or model "
              "switch until import-legacy runs")

Runner = Callable[[list[str]], subprocess.CompletedProcess]


def _default_runner(args: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(args, capture_output=True, text=True, timeout=TIMEOUT_S, check=False)


def available(env: dict | None = None) -> bool:
    """The journal is reachable from this process: a session of our own and the `reverie` CLI on PATH."""
    values = os.environ if env is None else env
    return bool(env_names.get("SESSION_ID", None, values)) and shutil.which("reverie", path=values.get("PATH")) is not None


def _call(args: list[str], runner: Runner) -> dict:
    done = runner(["reverie", "agent", "journal", *args, "--json"])
    try:
        body = json.loads(done.stdout or "{}")
    except ValueError:
        body = {}
    if done.returncode != 0 or body.get("success") is False:
        error = body.get("error") or (done.stderr or "").strip() or "journal unavailable"
        raise RuntimeError(str(error)[:500])
    return body.get("data", body)


def recall(query: str, project: str | None = None, runner: Runner = _default_runner) -> list[dict]:
    query = query.strip()
    if not query:
        raise ValueError("recall needs a query")
    return _call(["recall", query, *(["--project", project] if project else [])], runner)["entries"]


def save_args(request: dict) -> list[str]:
    """`journal save` arguments for a remember request; missing caller fields stay visible placeholders."""
    args = ["save", "--room", str(request.get("room") or "<room-id>"), "--turn", str(request.get("turn") or "<message-id>"),
            "--text", str(request.get("text", "")).strip(), "--tag", str(request.get("tag") or "<" + "|".join(TAGS) + ">")]
    if request.get("quote"):
        # The words come from the turn message itself, so the server checks them like any chat quote.
        args += ["--source", str(request.get("turn") or "<message-id>"), "--quote", str(request["quote"])]
    if request.get("source"):
        args += ["--ref", str(request["source"])]
    if not request.get("quote") and not request.get("source"):
        args += ["--source", str(request.get("turn") or "<message-id>"), "--quote", "<exact words from that message>"]
    if request.get("reason"):
        args += ["--reason", str(request["reason"])]
    if request.get("project"):
        args += ["--project", str(request["project"])]
    return args


def save_command(request: dict) -> str:
    return shlex.join(["reverie", "agent", "journal", *save_args(request)])


def remember(request: dict, runner: Runner = _default_runner) -> dict:
    missing = [name for name in ("room", "turn", "tag") if not isinstance(request.get(name), str) or not request[name].strip()]
    if not request.get("quote") and not request.get("source"):
        missing.append("quote or source")
    if request.get("tag") and request["tag"] not in TAGS:
        missing.append("a tag from: " + ", ".join(TAGS))
    if missing:
        # Refuse and show the command; never run it, and never fill in the room or turn ourselves.
        raise ValueError("remember needs " + ", ".join(missing) + ". Nothing was saved. To save it to your journal, run: "
                         + save_command(request))
    return _call(save_args(request), runner)
