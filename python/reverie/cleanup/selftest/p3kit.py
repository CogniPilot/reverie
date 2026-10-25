"""Phase-3 host test kit for reverie-prune (kit r5: maps the janitor's host paths via HOST-RESULT "sandbox") (roadmap T7d / proposal §6.7). Split across the two sides on purpose:
the LAPTOP side (this script, unprivileged, inside an agent laptop) builds a sandbox in the laptop's own /tmp and keeps
the live processes running (lease holders, an open file, a cwd, a libc mmap, a running executable, a zombie); the HOST
side (external Tim, root, host PID namespace) runs the installed prune against that sandbox with --test-root. So the
host's /proc view of container processes, flock and dev/ino across the container boundary, git-as-owner and mount
crossing are all exercised for real, which no in-laptop run can do.

  python3 -I p3kit.py run WORK [--wait-hours H] [--local-prune 'CMD' --lease-lib PATH]
    WORK  a NEW directory under /tmp. Writes WORK/HOST-RUN.md (the exact host commands), then waits for WORK/HOST-DONE,
          then checks every expectation and writes WORK/RESULT.json and RESULT.md, then stops its processes.
    --local-prune  rehearsal only: run that prune here (unprivileged) instead of waiting for the host; the mount case and
          the root-only expectations are then NOT RUN.
Every deletion the prune can make is inside WORK/sb (its --test-root). Nothing outside WORK is created or touched."""
import argparse, importlib.util, json, os, shlex, shutil, signal, subprocess, sys, time

HERE = os.path.dirname(os.path.realpath(__file__))
spec = importlib.util.spec_from_file_location("suite", os.path.join(HERE, "suite.py"))
S = importlib.util.module_from_spec(spec); spec.loader.exec_module(S)

ZOMBIE = "import os,sys,time\npid=os.fork()\nif pid==0: os._exit(0)\nprint('ok',flush=True)\ntime.sleep(int(sys.argv[1]))"
MMAP = ("import ctypes,os,sys,time\nlibc=ctypes.CDLL(None,use_errno=True)\nlibc.mmap.restype=ctypes.c_void_p\n"
        "libc.mmap.argtypes=[ctypes.c_void_p,ctypes.c_size_t,ctypes.c_int,ctypes.c_int,ctypes.c_int,ctypes.c_long]\n"
        "fd=os.open(sys.argv[1],os.O_RDONLY)\na=libc.mmap(None,4096,1,1,fd,0)\nos.close(fd)\nprint('ok',flush=True)\n"
        "time.sleep(int(sys.argv[2]))")
HOLD = "import sys,time\nf=open(sys.argv[1],'rb') if sys.argv[1] else None\nprint('ok',flush=True)\ntime.sleep(int(sys.argv[2]))"


def build(work, life_s):
    """Fixtures and live processes. Returns (sandbox, expectations, processes)."""
    sb = S.Sandbox(work, "sb")
    L = sb.laptop("L1")
    exp, procs = {}, []

    def proj(name, kind="build"):
        d = sb.project(L, name, kind); S.tree_bytes(d); return d

    def keep(p):
        procs.append(p); return p
    exp["control"] = (proj("control"), "DELETED", None)                       # nothing protects it: must go
    d = proj("leased"); keep(S.Holder(d, sb)); exp["leased"] = (d, "SKIP", "lease_held")
    d = proj("openfile"); keep(subprocess.Popen([sys.executable, "-I", "-c", HOLD, os.path.join(d, "f0.bin"), str(life_s)],
                                                 stdout=subprocess.PIPE, text=True, start_new_session=True))
    exp["openfile"] = (d, "SKIP", "open_file")
    d = proj("cwd"); keep(subprocess.Popen([sys.executable, "-I", "-c", HOLD, "", str(life_s)], cwd=os.path.join(d, "sub"),
                                            stdout=subprocess.PIPE, text=True, start_new_session=True))
    exp["cwd"] = (d, "SKIP", "cwd")
    d = proj("mmap"); keep(subprocess.Popen([sys.executable, "-I", "-c", MMAP, os.path.join(d, "sub", "deep.o"), str(life_s)],
                                             stdout=subprocess.PIPE, text=True, start_new_session=True))
    exp["mmap"] = (d, "SKIP", "open_file")                                     # maps dev must equal host st_dev
    d = proj("exe"); exe = os.path.join(d, "sub", "bin", "sleep"); os.makedirs(os.path.dirname(exe))
    shutil.copy(os.path.realpath(shutil.which("sleep")), exe); os.chmod(exe, 0o755); S.age_tree(d, 10)
    keep(subprocess.Popen([exe, str(life_s)], start_new_session=True)); exp["exe"] = (d, "SKIP", "open_file")
    d = proj("reserved", "downloads"); S.reserve(sb, d, until_s=6 * 3600); exp["reserved"] = (d, "SKIP", "reserved")
    keep(subprocess.Popen([sys.executable, "-I", "-c", ZOMBIE, str(life_s)], stdout=subprocess.PIPE, text=True,
                          start_new_session=True))                             # an unreaped child: must not block the pass
    d = proj("mount")                                                          # the host bind-mounts victim onto d/mnt
    os.makedirs(os.path.join(d, "mnt")); S.age_tree(d, 10)
    victim = os.path.join(sb.root, "victim"); S.write(os.path.join(victim, "only-copy.txt"), b"keep", age_days=10)
    S.age_tree(victim, 10)   # kit r5: an un-aged victim dir made the project look recently written, so a prune that
                             # crosses bind mounts was never reached (r10 passed the mount case as recent_write)
    exp["mount"] = (d, "NOT_DELETED", None)
    # An agent-owned checkout with a planted fsmonitor: the prune must run git as the owner, evaluate the checkout
    # (registered target deleted, not git_unsafe) and never execute the repo's fsmonitor command.
    co = S.make_checkout(sb.a, "owned", ignored=("target/",)); S.tree_bytes(os.path.join(co, "target"))
    marker = os.path.join(sb.root, "FSMONITOR-RAN")
    S.git(co, "config", "core.fsmonitor", f"touch {marker}; echo")
    S.registry_file(sb, "test/owned", ["target"]); S.age_tree(co, 10)
    exp["checkout"] = (os.path.join(co, "target"), "DELETED", None)
    for p in procs:
        if isinstance(p, subprocess.Popen) and p.stdout is not None and not isinstance(p, S.Holder):
            assert p.stdout.readline().strip() == "ok"
    time.sleep(0.3)
    config = sb.config(live=True)
    return sb, exp, procs, victim, marker, config


def rel_config(sb, config):
    """Rewrite the config with paths RELATIVE to the sandbox root, so it is valid at the host's path too."""
    out = []
    for line in open(config):
        k, v = line.split(" = ", 1)
        if k in ("b_mount", "registry_dir", "log_dir", "laptop_home_root"):
            v = json.dumps(os.path.relpath(json.loads(v), sb.root)) + "\n"
        elif k == "checkout_roots":
            v = json.dumps([os.path.relpath(p, sb.root) for p in json.loads(v)]) + "\n"
        out.append(f"{k} = {v}")
    path = os.path.join(sb.root, "prune.toml")
    open(path, "w").write("".join(out))
    return path


def check(sb, exp, victim, marker, host_sb=None):
    rows = []
    for f in os.listdir(sb.logs):
        if f.endswith(".jsonl"):
            rows += [json.loads(l) for l in open(os.path.join(sb.logs, f))]
    if host_sb and host_sb != sb.root:   # kit r5: the janitor logs HOST paths; map them to this side's view of the sandbox
        for r in rows:
            hp = r.get("host_path", "")
            if hp == host_sb or hp.startswith(host_sb + "/"):
                r["host_path"] = sb.root + hp[len(host_sb):]
    res = {}
    for name, (path, want, reason) in exp.items():
        got = S.decision(rows, path)
        reasons = S.reasons_of(rows, path)
        if want == "DELETED":
            ok = not os.path.lexists(path) and got == "DELETED"
        elif want == "NOT_DELETED":
            ok = os.path.exists(os.path.join(victim, "only-copy.txt"))
        else:
            ok = os.path.lexists(path) and got == want and reason in reasons
        res[name] = {"ok": ok, "decision": got, "reasons": reasons, "want": [want, reason]}
    res["fsmonitor_not_run"] = {"ok": not os.path.exists(marker)}
    res["victim_intact"] = {"ok": os.path.exists(os.path.join(victim, "only-copy.txt"))}
    res["no_proc_unreadable"] = {"ok": not any("proc_unreadable" in r.get("reasons", []) for r in rows)}
    return res, rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["run"])
    ap.add_argument("work")
    ap.add_argument("--wait-hours", type=float, default=6)
    ap.add_argument("--local-prune", default="")
    ap.add_argument("--lease-lib", default="")
    ap.add_argument("--extra", action="append", default=[], help="KEY=JSON added to the sandbox config")
    a = ap.parse_args()
    work = os.path.realpath(a.work)
    if not work.startswith("/tmp/") or os.path.exists(work):
        sys.exit(f"WORK must be a NEW path under /tmp: {work}")
    os.makedirs(work)
    for kv in a.extra:
        key, v = kv.split("=", 1)
        S.CONFIG_EXTRA[key] = json.loads(v)
    life = int(a.wait_hours * 3600) + 600
    sb, exp, procs, victim, marker, cfg = build(work, life)
    hcfg = rel_config(sb, cfg)
    mount_dir = os.path.join(exp["mount"][0], "mnt")
    rel = work[len("/tmp/"):]
    host = f"""# Phase-3 host run for this sandbox (Rex kit r4). Do NOT hand-run commands: use the reviewed ROOT runner,
# p3_host_runner.sh (in the kit packet), which never reads this sandbox's own config or a laptop-chosen library.
# As root on the host, with the INSTALLED, hash-checked prune and lease lib (never copies from this laptop):
#   p3_host_runner.sh --host-tmp <host path of this laptop's /tmp, i.e. its B folder + /tmp> --run {rel} \\
#       --python <pinned python> --prune <installed reverie_prune.py> --prune-sha <its sha256> \\
#       --lease-lib <installed lease.py> --lease-sha <its sha256> --run-id p3-host-1 --rev r10
# Add --with-mount ONLY once the prune has mount-identity detection (rex/prune-bind-mount-finding-r1).
# The runner writes HOST-RESULT.json and HOST-DONE here; this laptop then checks every expectation (RESULT.md).
"""
    open(os.path.join(work, "HOST-RUN.md"), "w").write(host)
    print(f"prepared {work}; host commands in {work}/HOST-RUN.md; config {hcfg}", flush=True)
    try:
        if a.local_prune:
            cmd = shlex.split(a.local_prune) + ["--config", hcfg, "--test-root", sb.root, "--pass", "all", "--live",
                                                "--run-id", "p3-local", "--test-df-pct", "100"]
            if a.lease_lib:
                with open(hcfg, "a") as f:
                    f.write(f"lease_lib = {json.dumps(os.path.realpath(a.lease_lib))}\n")
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=900)
            print("local prune exit", r.returncode, r.stderr[-300:], flush=True)
            open(os.path.join(work, "HOST-DONE"), "w").close()
        deadline = time.time() + a.wait_hours * 3600
        while not os.path.exists(os.path.join(work, "HOST-DONE")):
            if time.time() > deadline:
                print("TIMEOUT waiting for HOST-DONE", flush=True)
                break
            time.sleep(10)
        host = {}
        try:
            with open(os.path.join(work, "HOST-RESULT.json")) as f:
                host = json.load(f)                            # written by the root runner (p3_host_runner.sh)
        except (OSError, ValueError):
            pass
        res, rows = check(sb, exp, victim, marker, host.get("sandbox") if isinstance(host.get("sandbox"), str) else None)
        res["host_result"] = {"ok": (not host) or host.get("prune_rc") in (0, 4) and host.get("unmounted") is True,
                              "host": host or "none (local rehearsal or old HOST-RUN)"}
        if a.local_prune or not host.get("with_mount"):
            for k in ("mount", "victim_intact"):
                res[k]["note"] = "NOT RUN: no bind mount in this run (needs the prune's mount-identity fix and --with-mount)"
        json.dump({"results": res, "rows": len(rows)}, open(os.path.join(work, "RESULT.json"), "w"), indent=1)
        lines = [f"{'NOT RUN' if v.get('note') else ('PASS' if v['ok'] else 'FAIL')} {k} {v}" for k, v in res.items()]
        open(os.path.join(work, "RESULT.md"), "w").write("\n".join(lines) + "\n")
        print("\n".join(lines), flush=True)
    finally:
        for p in procs:
            try:
                os.killpg(p.p.pid if isinstance(p, S.Holder) else p.pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
        for p in procs:
            try:
                (p.p if isinstance(p, S.Holder) else p).wait(timeout=10)
            except Exception:
                pass


if __name__ == "__main__":
    main()
