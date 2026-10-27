"""reverie-prune self-test (r2, Rex; r2 = Stan N1/N2/N4): phase 3 run by the tracked module itself, so no one hand-runs root on the host.

Runs as root inside its systemd unit (PrivateMounts, PrivateTmp, ProtectSystem=strict, writable only --base and the
receipt dir). Steps:
  1. a fresh run dir under --base (on B, outside laptops_root), with a laptop "/tmp" owned by --uid/--gid;
  2. the LAPTOP side: kit r4 (p3kit.py run) as --uid/--gid in its OWN mount namespace with that dir bound at /tmp, so its
     holders' paths differ from the janitor's view, as in a real container. It builds the fixtures and keeps the
     holders alive (lease, open file, cwd, mmap, running exe, zombie, reservation, fsmonitor checkout, bind target);
  3. the HOST side: the reviewed root runner (p3_host_runner.sh) runs the module's prune LIVE with --test-root on that
     sandbox only, including the same-filesystem bind mount, unmounts and verifies, then writes HOST-DONE;
  4. the kit grades every expectation (RESULT.json). PASS needs runner exit 0, every result ok and nothing NOT RUN;
  5. the run dir is removed (unless the unmount failed) and a receipt is written atomically.
Exit 0 only on PASS. The receipt pins every file's sha256, so live enablement can name the exact bytes that passed.

  selftest.py --base DIR --uid U --gid G --python PY --prune FILE --prune-sha H --lease-lib FILE --lease-sha H
              --runner FILE --kit DIR --receipt FILE [--timeout S]
"""
import argparse, ctypes, datetime, hashlib, json, os, shutil, signal, stat, subprocess, sys, tempfile, time

# The reviewed bytes this self-test may run (kit r4 and runner r5). Anything else refuses before any effect.
KIT_SHA = {"p3kit.py": "cf4ca5a1b0fc84b2502e126be5a0c9b06881a11eba9161324efc1e352db0024a",
           "suite.py": "b94a3959f6a9a836f22e744c0c12041bea197d1744a4cc5e085f010afad96312"}
RUNNER_SHA = "5e5f776fcc158f4c54a17a0fac43c1ae2a5f403e78a4f6fc6cc2a1f1e624eab8"
WORK = "p3/w"                       # the kit's WORK, relative to the laptop /tmp
# r2 (Stan N1): PASS needs EXACTLY these kit checks, each a dict that is ok and not NOT RUN; an empty or partial result fails.
EXPECTED = frozenset({"checkout", "control", "cwd", "exe", "fsmonitor_not_run", "host_result", "leased", "mmap", "mount",
                      "no_proc_unreadable", "openfile", "reserved", "victim_intact"})
MS_BIND, MS_REC, MS_PRIVATE = 4096, 0x4000, 1 << 18


def sha(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def refuse(why):
    print("REFUSED: " + why, file=sys.stderr, flush=True)
    sys.exit(2)


def plain_root_dir(path):
    """Absolute, canonical, a real directory, root-owned and not group/world-writable, with no symlink on the way."""
    if not os.path.isabs(path) or os.path.realpath(path) != os.path.normpath(path):
        refuse(f"{path} must be absolute and canonical")
    cur = "/"
    for part in [p for p in path.split("/") if p]:
        cur = os.path.join(cur, part)
        if os.path.islink(cur):
            refuse(f"symlink in path: {cur}")
    st = os.lstat(path)
    if not stat.S_ISDIR(st.st_mode) or st.st_uid != 0 or st.st_mode & 0o022:
        refuse(f"{path} must be a root-owned directory, not group/world-writable")


def read_owned(path, uid, limit):
    """r2 (Stan N2): read a file the self-test uid wrote, without following a link or blocking on a FIFO: a regular file
    owned by that uid, at most `limit` bytes."""
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_uid != uid or st.st_size > limit:
            raise ValueError(f"{path}: not a regular file of uid {uid} within {limit} bytes")
        data = b""
        while len(data) <= limit:
            chunk = os.read(fd, 1 << 16)
            if not chunk:
                break
            data += chunk
        if len(data) > limit:
            raise ValueError(f"{path}: grew past {limit} bytes")
        return data
    finally:
        os.close(fd)


def laptop_side(tmp, uid, gid, py, kit, wait_h, log_fd):
    """Child: own mount AND pid namespace (like a container), the run's tmp bound at /tmp, the kit as pid 1 there.
    Killing this child kills the kit (PDEATHSIG), and the kernel then kills every holder in the pid namespace."""
    try:
        libc = ctypes.CDLL(None, use_errno=True)
        os.unshare(os.CLONE_NEWNS | os.CLONE_NEWPID)
        if libc.mount(b"none", b"/", None, MS_REC | MS_PRIVATE, None) != 0:
            raise OSError(ctypes.get_errno(), "make-private")
        if libc.mount(tmp.encode(), b"/tmp", None, MS_BIND, None) != 0:
            raise OSError(ctypes.get_errno(), "bind /tmp")
        os.dup2(log_fd, 1); os.dup2(log_fd, 2)
        kit_pid = os.fork()
        if kit_pid:
            _, status = os.waitpid(kit_pid, 0)
            os._exit(os.waitstatus_to_exitcode(status) & 0xff)
        os.setgroups([]); os.setgid(gid); os.setuid(uid)
        if os.getuid() != uid or os.geteuid() != uid or os.getgid() != gid:
            raise OSError("uid drop failed")
        libc.prctl(1, signal.SIGKILL, 0, 0, 0)   # PR_SET_PDEATHSIG, set AFTER the uid change (which clears it)
        # (pid 1 of a new pid namespace always sees getppid() == 0, so the parent can't be checked that way)
        os.chdir("/tmp")
        env = {"PATH": os.environ.get("PATH", "/run/current-system/sw/bin"), "HOME": "/tmp", "LANG": "C.UTF-8"}
        os.execve(py, [py, "-I", "-B", os.path.join(kit, "p3kit.py"), "run", "/tmp/" + WORK, "--wait-hours", str(wait_h)],
                  env)
    except BaseException as e:   # never return into the parent's code as root
        try:
            os.write(2, f"laptop side failed: {e}\n".encode())
        finally:
            os._exit(97)


class Child:
    """The laptop-side child, reaped exactly once."""
    def __init__(self, pid):
        self.pid, self.status = pid, None

    def poll(self):
        if self.status is None:
            try:
                done, status = os.waitpid(self.pid, os.WNOHANG)
            except ChildProcessError:
                done, status = self.pid, 0
            if done:
                self.status = status
        return self.status

    def stop(self, grace):
        end = time.time() + grace           # normally the kit has finished and stopped its holders by now
        while self.poll() is None and time.time() < end:
            time.sleep(0.5)
        if self.poll() is None:
            try:
                os.kill(self.pid, signal.SIGKILL)   # -> PDEATHSIG kills the kit (pid 1) -> the kernel kills every holder
            except ProcessLookupError:
                pass
            while self.poll() is None:
                time.sleep(0.1)


def wait_for(path, child, deadline):
    while time.time() < deadline:
        if os.path.lexists(path):
            return True
        if child.poll() is not None:
            return os.path.lexists(path)
        time.sleep(0.5)
    return False


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter, allow_abbrev=False)
    for flag in ("base", "python", "prune", "prune-sha", "lease-lib", "lease-sha", "runner", "kit", "receipt"):
        ap.add_argument("--" + flag, required=True)
    ap.add_argument("--uid", type=int, required=True)
    ap.add_argument("--gid", type=int, required=True)
    ap.add_argument("--timeout", type=float, default=600.0)
    ap.add_argument("--keep-on-fail", action="store_true", help="rehearsal only: keep the run dir when the test fails")
    a = ap.parse_args()
    if os.geteuid() != 0:
        refuse("must run as root (the module's self-test unit)")
    if a.uid <= 0 or a.gid <= 0:
        refuse("--uid/--gid must be a non-root laptop user")
    if not 60 <= a.timeout <= 1800:
        refuse("--timeout must be within 60-1800 s")
    plain_root_dir(a.base)
    for name, want in KIT_SHA.items():
        if sha(os.path.join(a.kit, name)) != want:
            refuse(f"kit {name} is not the reviewed kit r4")
    if sha(a.runner) != RUNNER_SHA:
        refuse("runner is not the reviewed runner r5")
    for path, want in ((a.prune, a.prune_sha), (a.lease_lib, a.lease_sha)):
        if sha(path) != want:
            refuse(f"{path} does not match its pinned sha256")

    started = time.time(); deadline = started + a.timeout
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    run = tempfile.mkdtemp(prefix=f"run-{stamp}-", dir=a.base)
    os.chmod(run, 0o711)
    tmp = os.path.join(run, "tmp")
    os.mkdir(tmp, 0o700); os.chown(tmp, a.uid, a.gid)
    log_fd = os.open(os.path.join(run, "kit.log"), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    work = os.path.join(tmp, WORK)
    result = {"status": "FAIL", "why": ""}
    unmount_failed = False
    pid = os.fork()
    if pid == 0:
        laptop_side(tmp, a.uid, a.gid, a.python, a.kit, max(0.05, a.timeout / 3600), log_fd)
    os.close(log_fd)
    child = Child(pid)
    try:
        if not wait_for(os.path.join(work, "HOST-RUN.md"), child, min(deadline, time.time() + 180)):
            result["why"] = "laptop side did not prepare its sandbox"
            return result
        env = {"PATH": os.environ.get("PATH", ""), "LANG": "C.UTF-8"}
        if os.environ.get("RUNTIME_DIRECTORY"):
            env["RUNTIME_DIRECTORY"] = os.environ["RUNTIME_DIRECTORY"].split(":")[0]
        r = subprocess.run(["bash", a.runner, "--host-tmp", tmp, "--run", WORK, "--python", a.python, "--prune", a.prune,
                            "--prune-sha", a.prune_sha, "--lease-lib", a.lease_lib, "--lease-sha", a.lease_sha,
                            "--run-id", "selftest-" + stamp, "--rev", "r10", "--with-mount"],
                           env=env, capture_output=True, text=True, timeout=max(30, deadline - time.time()))
        result["runner_rc"] = r.returncode
        result["runner_tail"] = (r.stdout + r.stderr)[-2000:]
        unmount_failed = r.returncode == 3
        if r.returncode != 0:
            result["why"] = f"runner exit {r.returncode}"
            return result
        # r2 (Stan N2): the kit writes RESULT.json, then RESULT.md; wait for RESULT.md, so RESULT.json is complete.
        if not wait_for(os.path.join(work, "RESULT.md"), child, deadline):
            result["why"] = "laptop side did not grade the run"
            return result
        logs = os.path.join(work, "sb", "logs", "selftest-" + stamp)
        try:              # the janitor's own summary and rows (fixture paths only), so a FAIL is diagnosable
            result["prune_summary"] = json.loads(read_owned(logs + ".summary.json", a.uid, 1 << 20))
        except (OSError, ValueError):
            result["prune_summary"] = None
        try:
            result["prune_rows"] = [json.loads(line) for line in read_owned(logs + ".jsonl", a.uid, 4 << 20).splitlines()][:200]
        except (OSError, ValueError):
            result["prune_rows"] = None
        try:
            graded = json.loads(read_owned(os.path.join(work, "RESULT.json"), a.uid, 1 << 20))["results"]
        except (OSError, ValueError, KeyError, TypeError) as e:
            result["why"] = f"kit result unreadable: {e}"
            return result
        result["results"] = graded
        if not isinstance(graded, dict) or set(graded) != EXPECTED or not all(isinstance(v, dict) for v in graded.values()):
            result["why"] = "kit result does not have exactly the expected checks"
            return result
        bad = sorted(k for k, v in graded.items() if v.get("ok") is not True or v.get("note"))
        if bad:
            result["why"] = "not ok or NOT RUN: " + ", ".join(bad)
            return result
        result["status"] = "PASS"; result["why"] = ""
        return result
    except subprocess.TimeoutExpired:
        result["why"] = "runner timed out"
        unmount_failed = True   # r2 (Stan N4): its trap never ran, so a bind mount may remain; keep the run dir, FAIL
        return result
    finally:
        child.stop(15)
        result["laptop_side_status"] = child.status
        result["elapsed_s"] = round(time.time() - started, 1)
        result["files"] = {"prune": [a.prune, a.prune_sha], "lease": [a.lease_lib, a.lease_sha],
                           "runner": [a.runner, RUNNER_SHA], "kit": KIT_SHA}
        result["version"] = 1; result["at"] = stamp
        try:
            with open(os.path.join(run, "kit.log"), "rb") as f:
                f.seek(0, 2); f.seek(max(0, f.tell() - 3000))
                result["kit_log_tail"] = f.read().decode("utf-8", "replace")
        except OSError:
            pass
        if result["status"] != "PASS" and a.keep_on_fail and not unmount_failed:
            result["kept"] = run
        elif unmount_failed:
            result["status"] = "FAIL"
            result["why"] = (result["why"] + "; " if result["why"] else "") + "unmount not confirmed; run dir kept for the operator"
        else:
            shutil.rmtree(run, ignore_errors=True)
            if os.path.lexists(run):
                result["status"] = "FAIL"; result["why"] = (result["why"] + "; " if result["why"] else "") + "run dir not removed"
        out = a.receipt
        fd, tmpname = tempfile.mkstemp(prefix=".receipt-", dir=os.path.dirname(out))
        with os.fdopen(fd, "w") as f:
            json.dump(result, f, indent=1, sort_keys=True); f.flush(); os.fsync(f.fileno())
        os.chmod(tmpname, 0o600); os.replace(tmpname, out)
        print(json.dumps({"status": result["status"], "why": result["why"], "receipt": out}), flush=True)


if __name__ == "__main__":
    outcome = main()
    sys.exit(0 if outcome and outcome.get("status") == "PASS" else 1)
