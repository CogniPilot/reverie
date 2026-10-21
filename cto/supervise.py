"""In-container supervisor for the console, so it can restart without stopping the container or its agents.

The container's command runs this file (standard library only, from the bind-mounted source) instead of the
console itself:

    supervise.py run --state DIR [--rollback-dist DIST] -- /usr/local/bin/reverie web ...

It starts the console as a child and keeps the container alive across console exits. The agents' tmux server is
a separate process, and the console re-adopts the live panes when it starts again (its own session
reconciliation), so a console restart leaves every agent running.

- `supervise.py restart --state DIR`: graceful restart (SIGTERM, then SIGKILL after a grace period). It returns
  once a new console process is running.
- A crash restarts the console with exponential backoff.
- A console that fails within FAST seconds of starting, three times in a row, is rolled back once to the previous
  build when `--rollback-dist` names a build directory that has a `<dist>.prev` next to it. If it still fails, the
  supervisor keeps retrying at the maximum backoff and writes an ALERT file; it never exits on its own.
- SIGTERM or SIGINT to the supervisor (an engine stop) is passed to the console, and the supervisor then exits.
  The exit status is 0 when the console goes on that SIGTERM, whether it handles it or dies of it (a console still
  starting up may not have its handler yet); otherwise it is the console's own status (128+N for signal N, e.g.
  137 for a console killed after the grace period). A stop that arrives while a console is being spawned still
  reaches that console.

State in DIR: supervisor.pid, child.json (pid, start time, counters), supervise.log (one coded line per event),
and ALERT when it needs a person.

Console environment (only with --env-root ROOT): DIR/child.env, if present, adds variables to the console's environment at every start, so a
setting persists across restarts without recreating the container. It is all or nothing: one line per KEY=VALUE
(blank lines and # comments allowed), only the exact names in ENV_RULES, each value checked by its rule. The state
dir is writable by every agent, so the file is never trusted: a missing file changes nothing, and a file that is
not a regular file, is over 4 KiB, or has any bad line is ignored as a whole, with an alert line in supervise.log.
The console then starts with the supervisor's own environment; a bad file never stops it. Values are never logged,
and no secret belongs in this file.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import signal
import stat
import subprocess
import sys
import time
from pathlib import Path

GRACE_SECONDS = 20.0
ENV_FILE = "child.env"
ENV_FILE_BYTES = 4096


def runtime_policy(value: str, root: Path) -> bool:
    """FLEET_RUNTIME_POLICY: an absolute path that resolves to a regular file strictly inside root."""
    if not value.startswith("/"):
        return False
    try:
        path = Path(value).resolve(strict=True)
        return root.resolve() in path.parents and stat.S_ISREG(path.stat().st_mode)
    except (OSError, RuntimeError):
        return False


ENV_RULES = {"FLEET_RUNTIME_POLICY": runtime_policy}
ENV_LINE = re.compile(r"([A-Z][A-Z0-9_]{0,63})=(.*)")


def read_env_file(path: Path, root: Path) -> dict[str, str]:
    """The checked variables of an env file; raises ValueError (with a reason, never a value) if any part is bad."""
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | getattr(os, "O_CLOEXEC", 0))
    except FileNotFoundError:
        return {}
    except OSError as error:
        raise ValueError(f"unreadable ({error.strerror})") from None
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise ValueError("not a regular file")
        data = os.read(fd, ENV_FILE_BYTES + 1)
    finally:
        os.close(fd)
    if len(data) > ENV_FILE_BYTES:
        raise ValueError(f"larger than {ENV_FILE_BYTES} bytes")
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        raise ValueError("not UTF-8") from None
    found: dict[str, str] = {}
    for number, line in enumerate(text.splitlines(), 1):
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        match = ENV_LINE.fullmatch(line)
        if not match:
            raise ValueError(f"line {number}: not KEY=VALUE")
        key, value = match.groups()
        if key not in ENV_RULES:
            raise ValueError(f"line {number}: {key} is not an allowed name")
        if key in found:
            raise ValueError(f"line {number}: {key} repeated")
        if not ENV_RULES[key](value, root):
            raise ValueError(f"line {number}: {key} has an invalid value")
        found[key] = value
    return found


class Supervisor:
    def __init__(self, command: list[str], state: Path, rollback_dist: Path | None = None, fast_seconds: float = 30.0,
                 max_backoff: float = 30.0, grace: float = GRACE_SECONDS, clock=time.monotonic, sleep=time.sleep,
                 env_root: Path | None = None):
        self.command, self.state, self.rollback_dist, self.env_root = command, state, rollback_dist, env_root
        self.fast_seconds, self.max_backoff, self.grace = fast_seconds, max_backoff, grace
        self.clock, self.sleep = clock, sleep
        self.child: subprocess.Popen | None = None
        self.started = 0.0
        self.restarts = 0
        self.fast_failures = 0
        self.rolled_back = False
        self.restart_requested = False
        self.stopping = False
        self.asked_at: float | None = None  # when a restart or stop was asked for: the grace period runs from here

    # ---- bookkeeping -------------------------------------------------------------------------
    def log(self, event: str, **fields) -> None:
        line = " ".join([time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), event] +
                        [f"{k}={v}" for k, v in fields.items()])
        print("supervise: " + line, file=sys.stderr, flush=True)
        with (self.state / "supervise.log").open("a") as f:
            f.write(line + "\n")

    def write_child(self) -> None:
        data = {"pid": self.child.pid if self.child else None, "started_at": time.time(), "restarts": self.restarts,
                "fast_failures": self.fast_failures, "rolled_back": self.rolled_back}
        tmp = self.state / "child.json.tmp"
        tmp.write_text(json.dumps(data))
        os.replace(tmp, self.state / "child.json")

    # ---- child control -----------------------------------------------------------------------
    def child_env(self) -> dict[str, str]:
        """The supervisor's environment plus the checked env file; never raises, so a bad file can't stop a start."""
        env = dict(os.environ)
        if self.env_root is None:
            return env
        try:
            extra = read_env_file(self.state / ENV_FILE, self.env_root)
        except Exception as error:  # noqa: BLE001  any failure means: start with the current environment
            self.log("alert", env_file="ignored", reason=str(error).replace(" ", "_"))
            return env
        if extra:
            env.update(extra)
            self.log("env_file", keys=",".join(sorted(extra)))
        return env

    def start(self) -> None:
        self.child = subprocess.Popen(self.command, env=self.child_env())
        if self.stopping and self.asked_at is None:
            self.ask_child_to_go()  # the stop arrived during the spawn, before self.child named this console
        self.started = self.clock()
        self.write_child()
        self.log("started", pid=self.child.pid, restarts=self.restarts)

    def wait_child(self) -> int:
        """Wait for the console to exit. After a restart or stop request it has the grace period to go on its own
        SIGTERM; then it is killed, so a console that ignores SIGTERM can never wedge a restart or an engine stop."""
        while True:
            try:
                return self.child.wait(timeout=0.2)
            except subprocess.TimeoutExpired:
                if self.asked_at is not None and self.clock() - self.asked_at > self.grace:
                    self.log("killed_after_grace", pid=self.child.pid)
                    self.child.kill()
                    self.asked_at = None

    def rollback(self) -> bool:
        """Swap the build for the previous one, once. Keeps the failed build for inspection."""
        if self.rolled_back or not self.rollback_dist:
            return False
        prev = self.rollback_dist.with_name(self.rollback_dist.name + ".prev")
        if not prev.is_dir():
            self.log("rollback_unavailable", missing=prev)
            return False
        failed = self.rollback_dist.with_name(f"{self.rollback_dist.name}.failed-{int(time.time())}")
        os.replace(self.rollback_dist, failed)
        os.replace(prev, self.rollback_dist)
        self.rolled_back = True
        self.log("rolled_back", kept=failed)
        return True

    # ---- signals -----------------------------------------------------------------------------
    def ask_child_to_go(self) -> None:
        if self.child and self.child.poll() is None:
            self.asked_at = self.clock()
            self.child.terminate()

    def on_restart(self, *_):
        self.restart_requested = True
        self.ask_child_to_go()

    def on_stop(self, *_):
        self.stopping = True
        self.ask_child_to_go()

    # ---- main loop ---------------------------------------------------------------------------
    @staticmethod
    def stop_status(code: int) -> int:
        """The supervisor's exit status after an engine stop. A console that died of the SIGTERM passed on to it
        stopped cleanly, exactly like one that handled it; any other status is the console's own."""
        if code == -signal.SIGTERM:
            return 0
        return code if code >= 0 else 128 - code

    def after_exit(self, code: int) -> float:
        """Decide what happens after the console exited; returns the delay before the next start."""
        uptime = self.clock() - self.started
        if self.restart_requested:
            self.restart_requested = False
            self.fast_failures = 0
            self.log("restarted_on_request", code=code)
            return 0.0
        self.fast_failures = self.fast_failures + 1 if uptime < self.fast_seconds else 1
        self.log("exited", code=code, uptime=round(uptime, 1), fast_failures=self.fast_failures)
        if self.fast_failures >= 3:
            if self.rollback():
                self.fast_failures = 0
                return 0.0
            (self.state / "ALERT").write_text(f"console keeps failing: exit {code}; see supervise.log\n")
            self.log("alert", fast_failures=self.fast_failures)
        return min(self.max_backoff, 2.0 ** max(0, self.fast_failures - 1))

    def run(self) -> int:
        self.state.mkdir(parents=True, exist_ok=True)
        (self.state / "supervisor.pid").write_text(str(os.getpid()))
        signal.signal(signal.SIGUSR1, self.on_restart)
        signal.signal(signal.SIGTERM, self.on_stop)
        signal.signal(signal.SIGINT, self.on_stop)
        self.start()
        while True:
            code = self.wait_child()
            self.asked_at = None
            if self.stopping:
                self.log("stopped", code=code)
                return self.stop_status(code)
            delay = self.after_exit(code)
            waited = 0.0
            while waited < delay and not self.stopping and not self.restart_requested:
                self.sleep(0.2)
                waited += 0.2
            if self.stopping:
                self.log("stopped", code=code)
                return 0
            self.restarts += 1
            self.start()


def request_restart(state: Path, timeout: float = 60.0) -> int:
    """Ask the running supervisor for a graceful restart; wait until a NEW console process is up."""
    try:
        pid = int((state / "supervisor.pid").read_text())
        before = json.loads((state / "child.json").read_text()).get("pid")
        os.kill(pid, signal.SIGUSR1)
    except (OSError, ValueError) as error:
        print(f"supervise: no running supervisor in {state}: {error}", file=sys.stderr)
        return 2
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            now = json.loads((state / "child.json").read_text()).get("pid")
        except (OSError, ValueError):
            now = None
        if now and now != before:
            print(f"supervise: console restarted: pid {before} -> {now}")
            return 0
        time.sleep(0.2)
    print("supervise: no new console process within the timeout; see supervise.log", file=sys.stderr)
    return 1


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="action", required=True)
    run = sub.add_parser("run")
    run.add_argument("--state", type=Path, required=True)
    run.add_argument("--rollback-dist", type=Path)
    run.add_argument("--fast-seconds", type=float, default=30.0)
    run.add_argument("--max-backoff", type=float, default=30.0)
    run.add_argument("--grace", type=float, default=GRACE_SECONDS)
    run.add_argument("--env-root", type=Path, help="read DIR/child.env; FLEET_RUNTIME_POLICY must resolve inside this dir")
    run.add_argument("command", nargs=argparse.REMAINDER)
    for name in ("restart", "status"):
        p = sub.add_parser(name)
        p.add_argument("--state", type=Path, required=True)
    args = parser.parse_args(argv)
    if args.action == "run":
        command = args.command[1:] if args.command[:1] == ["--"] else args.command
        if not command:
            parser.error("give the console command after --")
        return Supervisor(command, args.state, args.rollback_dist, args.fast_seconds, args.max_backoff, args.grace,
                          env_root=args.env_root).run()
    if args.action == "restart":
        return request_restart(args.state)
    try:
        print((args.state / "child.json").read_text())
        return 0
    except OSError:
        print(f"supervise: no state in {args.state}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
