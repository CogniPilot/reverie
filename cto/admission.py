"""Memory-aware admission: refuse new work when the container cgroup cannot hold it.

The 2026-10-15 CTO pane was SIGKILLed by the cgroup OOM killer (4 GiB, no swap) when
a test run spawned dozens of workers. Before starting a session or a heavy command,
require  used + expected <= limit - reserve,  where used excludes reclaimable
inactive page cache. Without a cgroup limit everything is admitted.

    python3 -m cto.admission --expect 1.5G -- npm test
"""
from __future__ import annotations
import argparse
import os
import re
from pathlib import Path

MiB = 1 << 20
DEFAULT_RESERVE = 512 * MiB
# Measured PSS per runtime incl. children on 2026-10-15 (claude 248-373 MiB,
# opencode 990 MiB) rounded up for growth. Owners may override in the policy.
DEFAULT_SESSION_COST = {"claude": 400 * MiB, "codex": 400 * MiB, "opencode": 1100 * MiB}
EX_TEMPFAIL = 75


def parse_size(text):
    match = re.fullmatch(r"\s*(\d+(?:\.\d+)?)\s*([KMGT]?)i?B?\s*", str(text), re.I)
    if not match: raise ValueError("size must look like 512M or 1.5G")
    return int(float(match.group(1)) * 1024 ** " KMGT".index(match.group(2).upper() or " "))


def usage(cgroup=Path("/sys/fs/cgroup")):
    """(used, limit) in bytes; limit is None when the cgroup is unlimited or unreadable."""
    try:
        limit = (cgroup / "memory.max").read_text().strip()
        current = int((cgroup / "memory.current").read_text())
        stat = dict(line.split() for line in (cgroup / "memory.stat").read_text().splitlines() if line.strip())
    except (OSError, ValueError):
        return None, None
    used = max(0, current - int(stat.get("inactive_file", 0)))
    return used, None if limit == "max" else int(limit)


def admit(expected, reserve=DEFAULT_RESERVE, cgroup=Path("/sys/fs/cgroup")):
    used, limit = usage(cgroup)
    if limit is None:
        return {"admitted": True, "reason": "no cgroup memory limit"}
    available = limit - reserve - used
    result = {"admitted": expected <= available, "used": used, "limit": limit, "reserve": reserve,
              "expected": expected, "available": available}
    if not result["admitted"]:
        result["reason"] = "need %d MiB, %d MiB available below the %d MiB reserve" % (
            expected // MiB, max(available, 0) // MiB, reserve // MiB)
    return result


def session_admission(policy, mode, cgroup=Path("/sys/fs/cgroup")):
    config = policy.get("memory_admission", {})
    costs = dict(DEFAULT_SESSION_COST, **config.get("session_cost_bytes", {}))
    return admit(costs.get(mode, max(costs.values())), config.get("reserve_bytes", DEFAULT_RESERVE), cgroup)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--expect", required=True, type=parse_size, help="expected peak memory of the command")
    parser.add_argument("--reserve", default=DEFAULT_RESERVE, type=parse_size)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)
    result = admit(args.expect, args.reserve)
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not result["admitted"]:
        print("admission refused: " + result["reason"], flush=True)
        return EX_TEMPFAIL
    if command: os.execvp(command[0], command)
    print("admitted", flush=True)
    return 0


if __name__ == "__main__": raise SystemExit(main())
