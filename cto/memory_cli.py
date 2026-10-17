"""Portable memory tool for any agent CLI; explicit instance and scope required."""
from __future__ import annotations
import argparse
import json
import os
from pathlib import Path
import sys


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--instance", type=Path, default=os.environ.get("FLEET_INSTANCE_CONFIG"))
    args = parser.parse_args(argv)
    daemon = None
    try:
        if not args.instance:
            raise ValueError("select an instance with --instance or FLEET_INSTANCE_CONFIG")
        request = json.load(sys.stdin)
        if not isinstance(request, dict) or request.get("action") not in ("recall", "remember"):
            raise ValueError("expected a recall or remember JSON object")
        project = request.get("project")
        private = request.pop("private", False)
        if bool(project) == bool(private):
            raise ValueError("select exactly one project or private scope")
        if private and request.get("channel") == "work":
            raise ValueError("private memory is unavailable in shared channels")
        if project:
            request["channel"] = "work"
        from .config import Config
        from .chat import ChatDaemon
        from .opencode import dispatch
        daemon = ChatDaemon(cfg=Config(instance_config=Path(args.instance)))
        print(json.dumps(dispatch(daemon.brain, request), ensure_ascii=False))
        return 0
    except Exception as error:
        print(json.dumps({"error": str(error)}), file=sys.stderr)
        return 1
    finally:
        if daemon:
            daemon.brain.store.close()


if __name__ == "__main__":
    raise SystemExit(main())
