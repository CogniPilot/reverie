"""Launch the selected CLI with Reverie's actual per-session model selection."""
from __future__ import annotations
import argparse
import json
import os
from pathlib import Path
from .runtime import Reverie
from .instance import load_instance, primary_agent
from reverie import env_names


def argv_for(mode, model, agent="chat"):
    if not isinstance(model, str) or not model.strip():
        raise ValueError("the runtime policy must select a model explicitly")
    if mode == "opencode": return ["opencode", "--agent", agent, "--model", model]
    if mode == "codex": return ["codex", "--model", model]
    if mode == "claude": return ["claude", "--model", model]
    raise ValueError("unsupported CLI adapter")


def resolve_session(values, prefix):
    sessions = values.get("sessions", []) if isinstance(values, dict) else values
    matches = [session for session in sessions if session["id"].startswith(prefix)]
    if len(matches) != 1: raise ValueError("cannot uniquely resolve the current Reverie session")
    return matches[0]


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("opencode","codex","claude"))
    parser.add_argument("--describe", action="store_true")
    args=parser.parse_args(argv)
    url=os.environ.get("REVERIE_API_URL"); session_id=os.environ.get("REVERIE_SESSION_ID")
    if not url or not session_id: parser.error("Reverie API URL and session identity are required")
    api=Reverie(url)
    session=resolve_session(api.call("GET", "/api/v1/sessions"), session_id)
    if session.get("mode") != args.mode: parser.error("adapter does not match the current Reverie session")
    key={"opencode":"openCodeConfig","codex":"codexConfig"}.get(args.mode)
    model=session.get(key, {}).get("model") if key else session.get("model")
    marker=Path.cwd()/".reverie-instance"
    if marker.exists():
        settings=json.loads(marker.read_text())
        if settings.get("instance"): os.environ.update(env_names.entry("INSTANCE_CONFIG", settings["instance"]))
    config=env_names.lookup("REVERIE_INSTANCE_CONFIG")
    agent=primary_agent(load_instance(Path(config))) if config else "chat"
    command=argv_for(args.mode, model, agent)
    if args.describe: print(json.dumps({"mode":args.mode, "model":model, "argv":command})); return 0
    os.execvp(command[0], command)

if __name__ == "__main__": raise SystemExit(main())
