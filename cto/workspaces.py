"""Owned disposable task workspaces, leases and cleanup after a saved handoff."""
from __future__ import annotations
import argparse
from contextlib import contextmanager
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import time

class Workspaces:
    def __init__(self, root: Path):
        self.root = root.expanduser().resolve()
        marker = self.root / ".agent-fleet-owned"
        if not marker.exists() and self.root.exists() and any(self.root.iterdir()):
            raise ValueError("refusing an existing unowned workspace root")
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        marker.touch(mode=0o600, exist_ok=True)
        (self.root / ".leases").mkdir(exist_ok=True, mode=0o700)

    def path(self, name):
        if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}", name):
            raise ValueError("invalid workspace identifier")
        path = self.root / name
        if path.is_symlink():
            raise ValueError("workspace must not be a symlink")
        return path

    @contextmanager
    def lease(self, name):
        self.path(name)
        with (self.root / ".leases" / (name + ".lock")).open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            yield

    def create(self, name):
        with self.lease(name):
            path = self.path(name)
            path.mkdir(mode=0o700)
            self.write(path, {"id":name, "status":"allocated", "created_at":time.time()})
            return path

    def write(self, path, value):
        temp = path / ".fleet-task.json.tmp"
        temp.write_text(json.dumps(value) + "\n")
        temp.replace(path / ".fleet-task.json")

    def finish(self, name, handoff):
        if not handoff.strip():
            raise ValueError("save a handoff receipt before cleanup")
        with self.lease(name):
            path = self.path(name)
            value = json.loads((path / ".fleet-task.json").read_text())
            value.update(status="completed", handoff=handoff, completed_at=time.time())
            self.write(path, value)

    def clean(self, name, apply=False):
        with self.lease(name):
            path = self.path(name)
            value = json.loads((path / ".fleet-task.json").read_text())
            if value.get("id") != name or value.get("status") != "completed" or not value.get("handoff"):
                raise ValueError("workspace has no completed handoff")
            for current, dirs, files in os.walk(path, followlinks=False):
                if ".git" in dirs or ".git" in files:
                    raise ValueError("source checkout found; preserve it for review")
            if apply:
                shutil.rmtree(path)  # fd-safe on supported platforms; never follows links inside the tree.
            return {"workspace":name, "removed":apply}

    def run(self, name, command):
        with self.lease(name):
            path = self.path(name)
            metadata = path / ".fleet-task.json"
            value = json.loads(metadata.read_text())
            if value.get("status") == "completed":
                raise ValueError("completed workspace cannot start new work")
            env = dict(os.environ)
            for key, directory in (("TMPDIR","tmp"),("CARGO_TARGET_DIR","build")):
                target = path / directory; target.mkdir(exist_ok=True); env[key] = str(target)
            result = subprocess.run(command, cwd=path, env=env)
            self.write(path, {**value, "status":"awaiting_handoff" if result.returncode == 0 else "failed",
                              "exit_code":result.returncode})
            return result.returncode


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path.home()/"scratch/agent-fleet/tasks")
    sub = parser.add_subparsers(dest="action", required=True)
    sub.add_parser("create").add_argument("name")
    run = sub.add_parser("run"); run.add_argument("name"); run.add_argument("command", nargs=argparse.REMAINDER)
    finish = sub.add_parser("finish"); finish.add_argument("name"); finish.add_argument("--handoff", required=True)
    clean = sub.add_parser("clean"); clean.add_argument("name"); clean.add_argument("--apply", action="store_true")
    args = parser.parse_args(argv); manager = Workspaces(args.root)
    if args.action == "create": print(manager.create(args.name))
    elif args.action == "finish": manager.finish(args.name, args.handoff)
    elif args.action == "clean": print(json.dumps(manager.clean(args.name, args.apply)))
    else:
        command = args.command[1:] if args.command[:1] == ["--"] else args.command
        if not command: parser.error("run requires a command")
        return manager.run(args.name, command)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
