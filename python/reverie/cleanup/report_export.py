"""Export an aggregate of the newest cleanup run to a report directory a reviewer can read.

  report_export.py --state DIR --out DIR --uid U --gid G

Runs after every cleanup run (success or failure). As root it reads only the newest <state>/logs/*.summary.json,
never the per-path log, and keeps only aggregate status, counts, space and duration: no paths, laptop ids or
repositories. A child that has dropped to --uid/--gid writes the result, so a directory owned by that user cannot
turn the write into a root write. Every path component is opened without following symlinks, and files are
replaced atomically. The output is latest.json, written after every run including failed ones, and <run_id>.json
for each new summary, keeping the newest KEEP. latest.json carries the aggregate only when this run wrote a new
summary; otherwise it names the newest earlier run and its summary is null.
"""
import argparse
import datetime
import json
import os
import re
import stat
import sys

KEEP = 60
SUMMARY_LIMIT = 4 << 20
SUMMARY = re.compile(r"(\d{8}T\d{6}Z-[A-Za-z0-9]+)\.summary\.json")
HISTORY = re.compile(r"\d{8}T\d{6}Z-[A-Za-z0-9]+\.json")
DIRECTORY = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC


def open_directory(path):
    """Open an absolute directory one component at a time, refusing a symlink anywhere on the way."""
    if not os.path.isabs(path):
        raise ValueError(f"{path}: not absolute")
    fd = os.open("/", DIRECTORY)
    try:
        for part in [p for p in path.split("/") if p]:
            if part in (".", ".."):
                raise ValueError(f"{path}: not canonical")
            child = os.open(part, DIRECTORY, dir_fd=fd)
            os.close(fd)
            fd = child
        return fd
    except BaseException:
        os.close(fd)
        raise


def newest_summary(state):
    """(run_id, summary) of the newest run summary, or (None, None) when there is none yet."""
    try:
        logs = open_directory(os.path.join(state, "logs"))
    except FileNotFoundError:
        return None, None
    try:
        runs = sorted(m.group(1) for m in map(SUMMARY.fullmatch, os.listdir(logs)) if m)
        if not runs:
            return None, None
        fd = os.open(f"{runs[-1]}.summary.json", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=logs)
        try:
            st = os.fstat(fd)
            if not stat.S_ISREG(st.st_mode) or st.st_size > SUMMARY_LIMIT:
                raise ValueError(f"{runs[-1]}.summary.json: not a regular file within {SUMMARY_LIMIT} bytes")
            data = os.read(fd, SUMMARY_LIMIT + 1)
        finally:
            os.close(fd)
        if len(data) > SUMMARY_LIMIT:
            raise ValueError(f"{runs[-1]}.summary.json: grew past {SUMMARY_LIMIT} bytes")
        return runs[-1], json.loads(data)
    finally:
        os.close(logs)


def disk(rows):
    return [{key: row.get(key) for key in ("total", "free", "used_pct")} for row in rows or []]


def aggregate(run_id, summary, now):
    """Status, counts, space and duration only."""
    started = datetime.datetime.strptime(run_id[:16], "%Y%m%dT%H%M%SZ").replace(tzinfo=datetime.timezone.utc)
    bytes_by_decision = {}
    for decisions in (summary.get("by_laptop") or {}).values():
        for decision, size in decisions.items():
            bytes_by_decision[decision] = bytes_by_decision.get(decision, 0) + int(size)
    return {"run_id": run_id, "mode": summary.get("mode"), "exit": summary.get("exit"),
            "passes": summary.get("passes"), "started_utc": started.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "duration_s": max(0, int((now - started).total_seconds())),
            "deleted_or_would_bytes": summary.get("deleted_or_would_bytes"),
            "count_by_decision": summary.get("by_decision") or {}, "laptop_bytes_by_decision": bytes_by_decision,
            "laptops": len(summary.get("by_laptop") or {}), "ceiling_bytes": summary.get("ceiling_bytes"),
            "ceiling_hit": summary.get("ceiling_hit"), "disk_before": disk(summary.get("df_before")),
            "disk_after": disk(summary.get("df_after"))}


def publish(out, name, record):
    tmp = f".tmp-{os.getpid()}-{os.urandom(6).hex()}"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o644, dir_fd=out)
    try:
        os.fchmod(fd, 0o644)
        os.write(fd, (json.dumps(record, indent=1, sort_keys=True) + "\n").encode())
        os.fsync(fd)
    finally:
        os.close(fd)
    os.rename(tmp, name, src_dir_fd=out, dst_dir_fd=out)


def write_reports(directory, record, run_id, keep=KEEP):
    """Runs as the report user. Returns whether this run added a new summary."""
    out = open_directory(directory)
    try:
        fresh = False
        if run_id is not None:
            try:
                os.stat(f"{run_id}.json", dir_fd=out, follow_symlinks=False)
            except FileNotFoundError:
                publish(out, f"{run_id}.json", record["summary"])
                fresh = True
        publish(out, "latest.json", dict(record, run_id=run_id, new_summary=fresh, summary=record["summary"] if fresh else None))
        for old in sorted(n for n in os.listdir(out) if HISTORY.fullmatch(n))[:-keep]:
            os.unlink(old, dir_fd=out)
        return fresh
    finally:
        os.close(out)


def drop_to(uid, gid):
    if os.getuid() == uid and os.getgid() == gid:
        return
    os.setgroups([])
    os.setgid(gid)
    os.setuid(uid)
    if os.getuid() != uid or os.geteuid() != uid or os.getgid() != gid:
        raise PermissionError("could not drop to the report user")


def main(argv=None):
    ap = argparse.ArgumentParser(prog="reverie-prune-report-export")
    ap.add_argument("--state", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--uid", type=int, required=True)
    ap.add_argument("--gid", type=int, required=True)
    args = ap.parse_args(argv)
    if args.uid == 0 or args.gid == 0:
        print("reverie-prune-report-export: the report user must not be root", file=sys.stderr)
        return 2
    now = datetime.datetime.now(datetime.timezone.utc)
    try:
        run_id, summary = newest_summary(args.state)
        record = {"finished_utc": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
                  "service_result": os.environ.get("SERVICE_RESULT", ""), "exit_code": os.environ.get("EXIT_CODE", ""),
                  "exit_status": os.environ.get("EXIT_STATUS", ""),
                  "summary": aggregate(run_id, summary, now) if run_id else None}
    except (OSError, ValueError) as error:
        print(f"reverie-prune-report-export: {error}", file=sys.stderr)
        return 1
    pid = os.fork()
    if pid == 0:
        try:
            drop_to(args.uid, args.gid)
            write_reports(args.out, record, run_id)
            os._exit(0)
        except BaseException as error:  # never return into the root parent's code
            print(f"reverie-prune-report-export: {error}", file=sys.stderr)
            os._exit(1)
    _, status = os.waitpid(pid, 0)
    return os.waitstatus_to_exitcode(status) and 1


if __name__ == "__main__":
    sys.exit(main())
