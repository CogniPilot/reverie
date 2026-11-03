"""Independent pre-live acceptance suite for reverie-prune (roadmap T7d). Written against prune-spec r4 (19792d84)
and the lease contract r8 (SHA256SUMS 84787809); NOT against the implementation. Run: python3 -I suite.py --prune 'CMD' --work DIR
  CMD   the prune command, split on spaces (e.g. '/path/reverie-prune' or 'python3 -I /path/prune.py').
  DIR   a NEW directory under /tmp; everything the suite creates lives there and is removed at the end (--keep keeps it).
Each case builds its own fixture tree, writes its own config, runs the prune, then checks both the JSONL log and the
filesystem. A case FAILS on any unexpected deletion, missing deletion, wrong decision or wrong exit code.
Cases marked HOST need root or the host's PID view and are reported NOT RUN here (they run in phase 3 on the host).
Spec points still open upstream are isolated in LEASE_KEY and CONFIG_EXTRA so a contract change is a one-line edit."""
import argparse, fcntl, json, os, shlex, shutil, signal, subprocess, sys, tempfile, time

DAY = 86400
# --- contract points (lease contract r3 = prune-spec r4 §2b) -------------------------------------------------------
def LEASE_KEY(st):
    return f"{st.st_dev}-{st.st_ino}"


def lease_dir(sb, lid):
    """Host view of laptop LID's persistent lease dir: <runtime>/workers/employees/<id>/home/.local/state/reverie/leases."""
    return os.path.join(sb.runtime, "workers", "employees", lid, "home", ".local", "state", "reverie", "leases")


CONFIG_EXTRA = {}  # extra config keys for an implementation under test (none needed for reverie-prune r2)


HOLDER = r"""
import fcntl, json, os, sys, time
d, leases, mode = sys.argv[1], sys.argv[2], sys.argv[3]
os.makedirs(leases, exist_ok=True)
b = os.open(os.path.join(leases, "barrier.lock"), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
fcntl.flock(b, fcntl.LOCK_SH)                                   # contract r3: every acquisition takes the barrier SH
if mode == "barrier-only":                                      # an acquisition stuck mid-way: barrier SH, nothing else
    print("held", flush=True); time.sleep(3600)
try:
    st = os.stat(d, follow_symlinks=False)
except FileNotFoundError:
    print("refused-gone", flush=True); sys.exit(3)
key = f"{st.st_dev}-{st.st_ino}"
if mode == "reserve":                                           # contract r3 RESERVE, created under barrier SH
    now = time.time()
    json.dump({"version": 1, "path": d, "owner": "prune-suite", "created_utc": now, "until_utc": now + 6 * 3600},
              open(os.path.join(leases, key + ".reserve.json"), "w"))
    fcntl.flock(b, fcntl.LOCK_UN); os.close(b)
    print("held", flush=True); time.sleep(3600)
p = os.path.join(leases, key + ".lock")
while True:                                                     # holder steps 1-4 plus the fstat == stat retry
    fd = os.open(p, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    fcntl.flock(fd, fcntl.LOCK_SH)
    q = os.stat(p); f = os.fstat(fd)
    if (q.st_dev, q.st_ino) == (f.st_dev, f.st_ino):
        break
    os.close(fd)
try:
    again = os.stat(d, follow_symlinks=False)
except FileNotFoundError:
    print("refused-gone", flush=True); sys.exit(3)
if (again.st_dev, again.st_ino) != (st.st_dev, st.st_ino):
    print("refused-replaced", flush=True); sys.exit(3)
json.dump({"path": d, "pid": os.getpid()}, open(os.path.join(leases, f"{key}.{os.getpid()}.json"), "w"))  # r4 per-holder metadata
fcntl.flock(b, fcntl.LOCK_UN); os.close(b)                      # barrier released; the lease stays held
print("held", flush=True)
time.sleep(3600)
"""


# --- fixture helpers ----------------------------------------------------------------------------------------------
def write(path, data=b"x" * 4096, age_days=None):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(data)
    if age_days is not None:
        t = time.time() - age_days * DAY
        os.utime(path, (t, t))


def age_tree(root, days):
    """Set every mtime under root (files, then dirs bottom-up) to `days` ago."""
    t = time.time() - days * DAY
    for d, dirs, files in os.walk(root, topdown=False):
        for n in files + [x for x in dirs if os.path.islink(os.path.join(d, x))]:
            os.utime(os.path.join(d, n), (t, t), follow_symlinks=False)  # dir-symlinks too (c13)
        os.utime(d, (t, t))


def tree_bytes(root, size=64 * 1024, files=4, age_days=10):
    for i in range(files):
        write(os.path.join(root, f"f{i}.bin"), b"\0" * size)
    write(os.path.join(root, "sub", "deep.o"), b"\0" * size)
    age_tree(root, age_days)


class Holder:
    """A separate process that acquires a lease on D exactly as contract r3 specifies (barrier SH, lock SH,
    fstat == stat, re-stat D, release barrier) and holds it for as long as it lives. It is the suite's own
    implementation of the holder side, so the prune is tested against the contract, not against the lease CLI."""

    def __init__(self, d, sb, lid="L1", mode="lease", wait=True):
        self.p = subprocess.Popen([sys.executable, "-I", "-c", HOLDER, d, lease_dir(sb, lid), mode],
                                  stdout=subprocess.PIPE, text=True, start_new_session=True)
        self.state = self.p.stdout.readline().strip() if wait else None
        if wait and self.state != "held":
            raise RuntimeError(f"holder did not start: {self.state}")

    def result(self, timeout=60):
        """For a holder started with wait=False: its first line (held / refused-gone / refused-replaced)."""
        if self.state is None:
            self.state = self.p.stdout.readline().strip()
        return self.state

    def kill(self):
        if self.p.poll() is None:
            os.killpg(self.p.pid, signal.SIGKILL)
            self.p.wait()


class OpenFile:
    """A process with a file inside the candidate open (check 3) or its cwd inside it (check 4)."""
    def __init__(self, path=None, cwd=None):
        code = "import sys,time\nf=open(sys.argv[1],'rb') if sys.argv[1] else None\nprint('ok',flush=True)\ntime.sleep(3600)"
        self.p = subprocess.Popen([sys.executable, "-I", "-c", code, path or ""], cwd=cwd, stdout=subprocess.PIPE,
                                  text=True, start_new_session=True)
        assert self.p.stdout.readline().strip() == "ok"

    def kill(self):
        if self.p.poll() is None:
            os.killpg(self.p.pid, signal.SIGKILL)
            self.p.wait()


def git(cwd, *a):
    subprocess.run(["git", "-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", *a], check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def make_checkout(root, name, ignored=("target/",), tracked=("src/lib.rs",), remote=None):
    co = os.path.join(root, name)
    os.makedirs(co)
    git(co, "init", "-q", "-b", "main")
    git(co, "remote", "add", "origin", remote or f"https://example.invalid/test/{name}.git")
    write(os.path.join(co, ".gitignore"), "".join(i + "\n" for i in ignored).encode())
    for t in tracked:
        write(os.path.join(co, t), b"// tracked\n")
    git(co, "add", "-A")
    git(co, "commit", "-q", "-m", "init")
    return co


# --- one sandbox per case -----------------------------------------------------------------------------------------
class Sandbox:
    def __init__(self, work, name):
        self.root = os.path.join(work, name)
        self.b = os.path.join(self.root, "B")                       # stands in for drive B (b_mount)
        self.laptops_rel = "laptops/employees"
        self.a = os.path.join(self.root, "A")                       # checkout_roots live here
        self.registry = os.path.join(self.root, "registry")
        self.logs = os.path.join(self.root, "logs")
        self.runtime = os.path.join(self.root, "runtime")           # host <runtime>; per-laptop homes live here
        for d in (self.b, self.a, self.registry, self.logs, self.runtime):
            os.makedirs(d)
        self.cleanups = []

    def laptop(self, lid="L1"):
        p = os.path.join(self.b, self.laptops_rel, lid)
        os.makedirs(os.path.join(p, "tmp", "reverie", "projects"), exist_ok=True)
        os.makedirs(lease_dir(self, lid), exist_ok=True)       # provisioning pre-creates every laptop's lease dir
        return p

    def project(self, laptop, h, kind="build"):
        return os.path.join(laptop, "tmp", "reverie", "projects", h, kind)

    def config(self, live=False, **over):
        c = dict(live_enabled=live, b_mount=self.b, laptops_root=self.laptops_rel, high_water_pct=1, low_water_pct=0,
                 idle_days=3, recent_write_hours=6, max_delete_bytes=200 << 30, registry_dir=self.registry,
                 checkout_roots=[self.a], log_dir=self.logs,
                 laptop_home_root=os.path.join(self.runtime, "workers", "employees"))
        # high 1 / low 0: the pass always runs and evicts every eligible candidate (it can never reach 0 %), so the
        # suite tests the checks and the order without a df knob. Stopping at low water needs CONFIG_EXTRA's knob.
        c.update(CONFIG_EXTRA)
        c.update(over)
        path = os.path.join(self.root, f"prune-{len(os.listdir(self.root))}.toml")
        with open(path, "w") as f:
            for k, v in c.items():
                f.write(f"{k} = {toml(v)}\n")
        return path

    def run(self, prune, cfg, *args):
        rid = f"suite-{os.getpid()}-{time.monotonic_ns()}"
        cmd = shlex.split(prune) + ["--config", cfg, "--test-root", self.root, "--run-id", rid, *args]
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
        log = os.path.join(self.logs, f"{rid}.jsonl")
        rows = [json.loads(l) for l in open(log)] if os.path.exists(log) else []
        return r.returncode, rows, r

    def close(self):
        for c in self.cleanups:
            c.kill()


def toml(v):
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return str(v)
    if isinstance(v, list):
        return "[" + ", ".join(toml(x) for x in v) + "]"
    return json.dumps(str(v))


def rows_for(rows, path):
    real = os.path.realpath(path)
    return [r for r in rows if os.path.realpath(r.get("host_path", "")) == real]


def decision(rows, path):
    ds = {r["decision"] for r in rows_for(rows, path)}
    return ds.pop() if len(ds) == 1 else (sorted(ds) or None)



def control(sb, L):
    """A sibling candidate with nothing protecting it: it MUST be deleted in the same live pass, so a prune that
    never deletes cannot pass a safety case."""
    d = sb.project(L, "zz-control"); tree_bytes(d); return d


def control_checkout(sb):
    co = make_checkout(sb.a, "zz-control", ignored=("target/",)); tree_bytes(os.path.join(co, "target"))
    registry_file(sb, "test/zz-control", ["target"]); age_tree(co, 10); return os.path.join(co, "target")


def expect_control(path):
    expect(not os.path.exists(path), "positive control survived: the prune deleted nothing in this pass")

# --- the cases ----------------------------------------------------------------------------------------------------
CASES = []


def case(tag="", host=False):
    def deco(fn):
        CASES.append((fn.__name__, tag, host, fn))
        return fn
    return deco


class Fail(Exception):
    pass


def expect(cond, msg):
    if not cond:
        raise Fail(msg)


@case("dry-run default deletes nothing")
def c01_dry_default(sb, prune):
    L = sb.laptop(); d = sb.project(L, "p1"); tree_bytes(d)
    rc, rows, _ = sb.run(prune, sb.config(live=True), "--pass", "high-water")
    expect(rc == 0, f"rc {rc}")
    expect(os.path.isdir(d), "deleted in default (dry) mode")
    expect(decision(rows, d) == "WOULD_DELETE", f"decision {decision(rows, d)}")


@case("--live without live_enabled refuses with exit 3 and touches nothing")
def c02_live_needs_both(sb, prune):
    L = sb.laptop(); d = sb.project(L, "p1"); tree_bytes(d)
    rc, rows, _ = sb.run(prune, sb.config(live=False), "--pass", "high-water", "--live")
    expect(rc == 3, f"rc {rc}, want 3")
    expect(os.path.isdir(d), "deleted although live_enabled=false")


@case("positive control: idle unleased candidate IS deleted live")
def c03_positive(sb, prune):
    L = sb.laptop(); d = sb.project(L, "p1"); tree_bytes(d)
    rc, rows, _ = sb.run(prune, sb.config(live=True), "--pass", "high-water", "--live")
    expect(rc == 0, f"rc {rc}")
    expect(not os.path.exists(d), "idle unleased candidate survived (prune deletes nothing?)")
    expect(decision(rows, d) == "DELETED", f"decision {decision(rows, d)}")


@case("held lease on the candidate blocks deletion; positive control in the same pass is deleted")
def c04_lease(sb, prune):
    L = sb.laptop(); held = sb.project(L, "held"); free = sb.project(L, "free")
    tree_bytes(held); tree_bytes(free)
    sb.cleanups.append(Holder(held, sb))
    rc, rows, _ = sb.run(prune, sb.config(live=True), "--pass", "high-water", "--live")
    expect(os.path.isdir(held) and os.path.exists(os.path.join(held, "f0.bin")), "leased tree deleted")
    expect(not os.path.exists(free), "positive control survived")
    expect("lease_held" in sum((r.get("reasons", []) for r in rows_for(rows, held)), []), "no lease_held reason")


@case("lease on an ancestor (the project dir) protects the candidate")
def c05_lease_ancestor(sb, prune):
    L = sb.laptop(); d = sb.project(L, "p1"); tree_bytes(d)
    ctl = control(sb, L)
    proj = os.path.dirname(d); age_tree(proj, 10)
    sb.cleanups.append(Holder(proj, sb))
    sb.run(prune, sb.config(live=True), "--pass", "high-water", "--live")
    expect(os.path.isdir(d), "candidate under a leased ancestor was deleted")
    expect_control(ctl)


@case("lease on a DESCENDANT (staged inputs inside the candidate) protects the whole candidate")
def c06_lease_descendant(sb, prune):
    L = sb.laptop(); d = sb.project(L, "p1"); tree_bytes(d)
    ctl = control(sb, L)
    staged = os.path.join(d, "staged-inputs"); write(os.path.join(staged, "deps.zip"), age_days=0.5)
    age_tree(d, 10)
    sb.cleanups.append(Holder(staged, sb))
    sb.run(prune, sb.config(live=True), "--pass", "high-water", "--live")
    expect(os.path.exists(os.path.join(staged, "deps.zip")), "leased staged input inside the candidate was deleted")
    expect_control(ctl)


@case("a leased dir under an UNREADABLE subdir of the candidate (chmod 000) still protects the candidate")
def c06b_unreadable_subdir(sb, prune):
    L = sb.laptop(); ctl = control(sb, L); d = sb.project(L, "p1"); tree_bytes(d)
    hidden = os.path.join(d, "sub", "locked"); staged = os.path.join(hidden, "inputs"); write(os.path.join(staged, "x"))
    age_tree(d, 10)
    sb.cleanups.append(Holder(staged, sb))
    os.chmod(hidden, 0)
    sb.cleanups.append(type("K", (), {"kill": lambda s: os.chmod(hidden, 0o755) if os.path.lexists(hidden) else None})())
    try:
        sb.run(prune, sb.config(live=True), "--pass", "high-water", "--live")
    finally:
        if os.path.lexists(hidden):
            os.chmod(hidden, 0o755)
    expect(os.path.exists(os.path.join(staged, "x")), "a lease hidden under an unreadable subdir was missed")
    expect_control(ctl)


@case("staged inputs idle for hours under a lease survive (lease contract); same tree after holder death is deletable")
def c07_staged_then_release(sb, prune):
    L = sb.laptop(); d = sb.project(L, "p1", "downloads")
    for n in ("src.tar", "deps.zip", "tool.bin"):
        write(os.path.join(d, n), age_days=0.5)
    age_tree(d, 10)
    h = Holder(d, sb); sb.cleanups.append(h)
    sb.run(prune, sb.config(live=True), "--pass", "high-water", "--live")
    expect(os.path.exists(os.path.join(d, "deps.zip")), "leased staged inputs deleted")
    h.kill()
    sb.run(prune, sb.config(live=True), "--pass", "high-water", "--live")
    expect(not os.path.exists(d), "after the holder died the tree was still not deletable (lease never released?)")


@case("open file inside the candidate blocks deletion")
def c09_open_file(sb, prune):
    L = sb.laptop(); d = sb.project(L, "p1"); tree_bytes(d)
    ctl = control(sb, L)
    sb.cleanups.append(OpenFile(path=os.path.join(d, "sub", "deep.o")))
    rc, rows, _ = sb.run(prune, sb.config(live=True), "--pass", "high-water", "--live")
    expect(os.path.exists(os.path.join(d, "sub", "deep.o")), "tree with an open file was deleted")
    expect_control(ctl)


class Proc:
    """A process running CODE (one argv string) that prints 'ok' once its hold is in place, then sleeps."""
    def __init__(self, code, *argv):
        self.p = subprocess.Popen([sys.executable, "-I", "-c", code, *argv], stdout=subprocess.PIPE, text=True,
                                  start_new_session=True)
        assert self.p.stdout.readline().strip() == "ok"

    def kill(self):
        if self.p.poll() is None:
            os.killpg(self.p.pid, signal.SIGKILL)
            self.p.wait()


@case("an open DIRECTORY fd inside the candidate (e.g. a walker or a tool holding a dir) blocks deletion")
def c09b_open_dir_fd(sb, prune):
    L = sb.laptop(); ctl = control(sb, L); d = sb.project(L, "p1"); tree_bytes(d)
    code = "import os,sys,time\nfd=os.open(sys.argv[1],os.O_RDONLY|os.O_DIRECTORY)\nprint('ok',flush=True)\ntime.sleep(3600)"
    sb.cleanups.append(Proc(code, os.path.join(d, "sub")))
    sb.run(prune, sb.config(live=True), "--pass", "high-water", "--live")
    expect(os.path.isdir(os.path.join(d, "sub")), "tree with an open directory fd was deleted")
    expect_control(ctl)


@case("a file MAPPED into a running process (fd closed, like a running test binary or .so) blocks deletion")
def c09c_mmapped(sb, prune):
    L = sb.laptop(); ctl = control(sb, L); d = sb.project(L, "p1"); tree_bytes(d)
    # libc mmap, then close the fd: only /proc/<pid>/maps shows the file (Python's mmap module keeps a dup'd fd).
    code = ("import ctypes,os,sys,time\nlibc=ctypes.CDLL(None,use_errno=True)\nlibc.mmap.restype=ctypes.c_void_p\n"
            "libc.mmap.argtypes=[ctypes.c_void_p,ctypes.c_size_t,ctypes.c_int,ctypes.c_int,ctypes.c_int,ctypes.c_long]\n"
            "fd=os.open(sys.argv[1],os.O_RDONLY)\na=libc.mmap(None,4096,1,1,fd,0)\nassert a not in (None,ctypes.c_void_p(-1).value)\n"
            "os.close(fd)\nassert not [x for x in os.listdir('/proc/self/fd') if os.path.realpath('/proc/self/fd/'+x)==os.path.realpath(sys.argv[1])]\n"
            "print('ok',flush=True)\ntime.sleep(3600)")
    sb.cleanups.append(Proc(code, os.path.join(d, "sub", "deep.o")))
    sb.run(prune, sb.config(live=True), "--pass", "high-water", "--live")
    expect(os.path.exists(os.path.join(d, "sub", "deep.o")), "tree with a file mapped into a live process was deleted")
    expect_control(ctl)


@case("a process EXECUTING a binary from the candidate (/proc/*/exe) blocks deletion")
def c09d_exe(sb, prune):
    L = sb.laptop(); ctl = control(sb, L); d = sb.project(L, "p1"); tree_bytes(d)
    exe = os.path.join(d, "sub", "bin", "sleep")      # keep the name: coreutils is a multi-call binary
    os.makedirs(os.path.dirname(exe)); shutil.copy(os.path.realpath(shutil.which("sleep")), exe)
    os.chmod(exe, 0o755); age_tree(d, 10)
    p = subprocess.Popen([exe, "3600"], start_new_session=True)
    sb.cleanups.append(type("K", (), {"kill": lambda s: (os.killpg(p.pid, signal.SIGKILL), p.wait())})())
    time.sleep(0.3)
    expect(p.poll() is None, "fixture: the copied binary did not stay running")
    sb.run(prune, sb.config(live=True), "--pass", "high-water", "--live")
    expect(os.path.exists(exe), "tree with a running executable was deleted")
    expect_control(ctl)


@case("a process cwd inside the candidate blocks deletion")
def c10_cwd(sb, prune):
    L = sb.laptop(); d = sb.project(L, "p1"); tree_bytes(d)
    ctl = control(sb, L)
    sb.cleanups.append(OpenFile(cwd=os.path.join(d, "sub")))
    sb.run(prune, sb.config(live=True), "--pass", "high-water", "--live")
    expect(os.path.isdir(os.path.join(d, "sub")), "tree containing a process cwd was deleted")
    expect_control(ctl)


@case("a write newer than recent_write_hours blocks deletion")
def c11_recent(sb, prune):
    L = sb.laptop(); d = sb.project(L, "p1"); tree_bytes(d)
    ctl = control(sb, L)
    write(os.path.join(d, "sub", "fresh.o"), age_days=1 / 24)  # 1 h old
    sb.run(prune, sb.config(live=True), "--pass", "high-water", "--live")
    expect(os.path.exists(os.path.join(d, "sub", "fresh.o")), "recently written tree deleted")
    expect_control(ctl)


@case(".keep in an ancestor blocks deletion")
def c12_keep(sb, prune):
    L = sb.laptop(); d = sb.project(L, "p1"); tree_bytes(d)
    ctl = control(sb, L)
    write(os.path.join(os.path.dirname(d), ".keep"), b"", age_days=10)
    sb.run(prune, sb.config(live=True), "--pass", "high-water", "--live")
    expect(os.path.isdir(d), "tree under .keep deleted")
    expect_control(ctl)


@case("a symlink inside the candidate to precious data outside: only the link goes")
def c13_symlink_inside(sb, prune):
    L = sb.laptop(); d = sb.project(L, "p1"); tree_bytes(d)
    precious = os.path.join(sb.root, "precious"); write(os.path.join(precious, "only-copy.txt"), b"keep", age_days=10)
    os.symlink(precious, os.path.join(d, "link-to-precious"))
    os.symlink(os.path.join(precious, "only-copy.txt"), os.path.join(d, "sub", "file-link"))
    age_tree(d, 10)
    sb.run(prune, sb.config(live=True), "--pass", "high-water", "--live")
    expect(os.path.exists(os.path.join(precious, "only-copy.txt")), "symlink target outside the candidate deleted")
    expect(not os.path.lexists(d), "positive control: the candidate itself should be deleted")


@case("a symlinked project dir (candidate path through a link) is not followed")
def c14_symlink_path(sb, prune):
    L = sb.laptop()
    ctl = control(sb, L)
    precious = os.path.join(sb.root, "precious"); tree_bytes(os.path.join(precious, "build"))
    os.symlink(precious, os.path.join(L, "tmp", "reverie", "projects", "linked"))
    sb.run(prune, sb.config(live=True), "--pass", "high-water", "--live")
    expect(os.path.exists(os.path.join(precious, "build", "f0.bin")), "followed a symlinked project dir")
    expect_control(ctl)


@case("held .cargo-lock blocks deletion")
def c16_cargo_lock(sb, prune):
    L = sb.laptop(); d = sb.project(L, "p1"); tree_bytes(d)
    ctl = control(sb, L)
    lock = os.path.join(d, "debug", ".cargo-lock"); write(lock, b"", age_days=10)
    code = "import fcntl,sys,time\nf=open(sys.argv[1],'r+')\nfcntl.flock(f,fcntl.LOCK_EX)\nprint('ok',flush=True)\ntime.sleep(3600)"
    p = subprocess.Popen([sys.executable, "-I", "-c", code, lock], stdout=subprocess.PIPE, text=True, start_new_session=True)
    assert p.stdout.readline().strip() == "ok"
    sb.cleanups.append(type("K", (), {"kill": lambda s: (os.killpg(p.pid, signal.SIGKILL), p.wait())})())
    sb.run(prune, sb.config(live=True), "--pass", "high-water", "--live")
    expect(os.path.exists(lock), "tree with a held cargo lock deleted")
    expect_control(ctl)


@case("the sccache dir is never a candidate")
def c17_sccache(sb, prune):
    L = sb.laptop(); d = os.path.join(sb.project(L, "p1", "cache"), "sccache"); tree_bytes(d)
    ctl = control(sb, L)
    rc, rows, _ = sb.run(prune, sb.config(live=True), "--pass", "high-water", "--live")
    expect(os.path.exists(os.path.join(d, "f0.bin")), "sccache contents deleted")
    expect_control(ctl)


@case("LRU order: oldest-used candidates are deleted first")
def c18_lru(sb, prune):
    L = sb.laptop(); ds = []
    for h, age in (("new", 8), ("old", 40), ("mid", 20)):
        d = sb.project(L, h); tree_bytes(d, age_days=age); ds.append((age, d))
    rc, rows, _ = sb.run(prune, sb.config(live=False), "--pass", "high-water")
    order = [os.path.realpath(r["host_path"]) for r in rows if r.get("decision") == "WOULD_DELETE"]
    want = [os.path.realpath(d) for _, d in sorted(ds, reverse=True)]
    expect([p for p in order if p in want] == want, f"order {order}")


@case("high-water stops at low water: with --test-df-pct just above low, only the oldest candidates go")
def c18b_low_water_stop(sb, prune):
    L = sb.laptop(); ds = []
    for h, age in (("a-oldest", 40), ("b-older", 30), ("c-newer", 20), ("d-newest", 10)):
        d = sb.project(L, h); tree_bytes(d, size=1 << 20, files=2, age_days=age); ds.append(d)
    vf = os.statvfs(sb.b); total = (vf.f_blocks - vf.f_bfree + vf.f_bavail) * vf.f_frsize
    per = sum(os.lstat(os.path.join(r, n)).st_blocks * 512 for r, _, fs in os.walk(ds[0]) for n in fs) + 4 * 4096
    pct = 50 + 100.0 * 1.5 * per / total          # one candidate is not enough to get under 50 %, two are
    rc, rows, _ = sb.run(prune, sb.config(live=True, high_water_pct=50, low_water_pct=50), "--pass", "high-water",
                         "--live", "--test-df-pct", f"{pct:.9f}")
    gone = [os.path.basename(os.path.dirname(d)) for d in ds if not os.path.exists(d)]
    expect(gone == ["a-oldest", "b-older"], f"deleted {gone}, want the two oldest only")


@case("--max-delete-bytes stops deleting and records STOPPED_CEILING")
def c19_ceiling(sb, prune):
    L = sb.laptop()
    for h in ("a", "b", "c"):
        tree_bytes(sb.project(L, h), size=1 << 20, files=2)
    rc, rows, _ = sb.run(prune, sb.config(live=True), "--pass", "high-water", "--live", "--max-delete-bytes", str(3 << 20))
    left = [h for h in ("a", "b", "c") if os.path.exists(sb.project(L, h))]
    expect(left, "ceiling ignored: everything deleted")
    expect(any(r.get("decision") == "STOPPED_CEILING" for r in rows), "no STOPPED_CEILING row")


def registry_file(sb, repo, entries):
    p = os.path.join(sb.registry, *repo.split("/")) + ".paths"
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w") as f:
        f.write("".join(e + "\n" for e in entries))
    return p


@case("checkouts: idle registered output deleted; source, .env and unregistered ignored files kept")
def c20_checkout_basic(sb, prune):
    co = make_checkout(sb.a, "repo1", ignored=("target/", ".env", "results/"))
    tree_bytes(os.path.join(co, "target", "debug"))
    write(os.path.join(co, ".env"), b"SECRET=1"); write(os.path.join(co, "results", "only.csv"), b"1,2")
    registry_file(sb, "test/repo1", ["target"])
    age_tree(co, 10)
    rc, rows, _ = sb.run(prune, sb.config(live=True), "--pass", "checkouts", "--live")
    expect(not os.path.exists(os.path.join(co, "target")), "registered idle output not deleted")
    for keep in ("src/lib.rs", ".env", "results/only.csv", ".git/HEAD"):
        expect(os.path.exists(os.path.join(co, keep)), f"{keep} deleted")


@case("checkouts: a tracked file under a registered path rejects the entry")
def c20b_tracked_under(sb, prune):
    co = make_checkout(sb.a, "repo2", ignored=("target/",), tracked=("src/lib.rs",))
    ctl = control_checkout(sb)
    write(os.path.join(co, "target", "keep.md"), b"tracked"); git(co, "add", "-f", "target/keep.md"); git(co, "commit", "-q", "-m", "t")
    tree_bytes(os.path.join(co, "target", "debug"))
    registry_file(sb, "test/repo2", ["target"]); age_tree(co, 10)
    sb.run(prune, sb.config(live=True), "--pass", "checkouts", "--live")
    expect(os.path.exists(os.path.join(co, "target", "keep.md")), "tracked file under registered path deleted")
    expect_control(ctl)


@case("checkouts: a branch .prune-paths that widens the set is refused (WIDEN_REFUSED)")
def c20c_widen(sb, prune):
    co = make_checkout(sb.a, "repo3", ignored=("target/", "data/"))
    ctl = control_checkout(sb)
    tree_bytes(os.path.join(co, "target")); tree_bytes(os.path.join(co, "data"))
    write(os.path.join(co, ".prune-paths"), b"target\ndata\n")
    registry_file(sb, "test/repo3", ["target"]); age_tree(co, 10)
    rc, rows, _ = sb.run(prune, sb.config(live=True), "--pass", "checkouts", "--live")
    expect(os.path.exists(os.path.join(co, "data", "f0.bin")), "branch-widened path deleted")
    expect(any(r.get("decision") == "WIDEN_REFUSED" for r in rows), "no WIDEN_REFUSED row")
    expect_control(ctl)


@case("checkouts: an unregistered repo is never touched (NOT_REGISTERED)")
def c20d_unregistered(sb, prune):
    co = make_checkout(sb.a, "repo4"); tree_bytes(os.path.join(co, "target")); age_tree(co, 10)
    ctl = control_checkout(sb)
    rc, rows, _ = sb.run(prune, sb.config(live=True), "--pass", "checkouts", "--live")
    expect(os.path.exists(os.path.join(co, "target", "f0.bin")), "unregistered repo pruned")
    expect(any(r.get("decision") == "NOT_REGISTERED" for r in rows), "no NOT_REGISTERED row")
    expect_control(ctl)


@case("checkouts: a bad registry entry rejects the whole file and touches nothing")
def c20e_bad_registry(sb, prune):
    co = make_checkout(sb.a, "repo5", ignored=("target/", "dist/"))
    tree_bytes(os.path.join(co, "target")); tree_bytes(os.path.join(co, "dist"))
    registry_file(sb, "test/repo5", ["target", "../repo5/dist"]); age_tree(co, 10)
    rc, rows, _ = sb.run(prune, sb.config(live=True), "--pass", "checkouts", "--live")
    expect(os.path.exists(os.path.join(co, "target", "f0.bin")), "good entry pruned although the file has a bad entry")
    expect(rc == 2 or any("registry_invalid" in r.get("reasons", []) for r in rows), f"rc {rc} and no registry_invalid")


@case("checkouts: a repo's planted core.fsmonitor is never executed (plain ls-files/check-ignore would run it)")
def c20f_fsmonitor(sb, prune):
    co = make_checkout(sb.a, "planted", ignored=("target/",)); tree_bytes(os.path.join(co, "target"))
    marker = os.path.join(sb.root, "FSMONITOR-RAN")
    git(co, "config", "core.fsmonitor", f"touch {marker}; echo")
    registry_file(sb, "test/planted", ["target"]); age_tree(co, 10)
    sb.run(prune, sb.config(live=True), "--pass", "checkouts", "--live")
    expect(not os.path.exists(marker), "the prune executed the repo's core.fsmonitor command")
    expect(not os.path.exists(os.path.join(co, "target")), "positive control: the registered output should be deleted")


@case("checkouts: recent source edit makes the checkout not idle")
def c21_not_idle(sb, prune):
    co = make_checkout(sb.a, "repo6"); tree_bytes(os.path.join(co, "target"))
    ctl = control_checkout(sb)
    registry_file(sb, "test/repo6", ["target"]); age_tree(co, 10)
    write(os.path.join(co, "src", "lib.rs"), b"// edited today\n")
    sb.run(prune, sb.config(live=True), "--pass", "checkouts", "--live")
    expect(os.path.exists(os.path.join(co, "target", "f0.bin")), "output of a non-idle checkout deleted")
    expect_control(ctl)


@case("retired pass never deletes, even with --live")
def c22_retired(sb, prune):
    old = os.path.join(sb.b, "laptops", "old-seat"); tree_bytes(old)
    rc, rows, _ = sb.run(prune, sb.config(live=True), "--pass", "retired", "--live")
    expect(os.path.exists(os.path.join(old, "f0.bin")), "retired folder deleted")
    expect(any(r.get("decision") == "REPORT" for r in rows), "no REPORT row for the retired folder")


@case("log rows hold metadata only: no file contents from the fixtures")
def c25_log_hygiene(sb, prune):
    L = sb.laptop(); d = sb.project(L, "p1"); write(os.path.join(d, "secret.txt"), b"CANARY-7f3a91", age_days=10)
    age_tree(d, 10)
    sb.run(prune, sb.config(live=False), "--pass", "high-water")
    blob = "".join(open(os.path.join(sb.logs, f)).read() for f in os.listdir(sb.logs))
    expect("CANARY-7f3a91" not in blob, "file contents leaked into the log")


def reserve(sb, d, lid="L1", until_s=3600, raw=None):
    """Contract r3 RESERVE: <key>.reserve.json written under barrier SH. raw= writes a malformed body instead."""
    leases = lease_dir(sb, lid); os.makedirs(leases, exist_ok=True)
    b = os.open(os.path.join(leases, "barrier.lock"), os.O_RDWR | os.O_CREAT, 0o600)
    fcntl.flock(b, fcntl.LOCK_SH)
    try:
        st = os.stat(d, follow_symlinks=False); now = time.time()
        created = min(now, now + until_s - 3600)    # an expired one was created before it expired (well-formed)
        body = raw if raw is not None else json.dumps({
            "version": 1, "path": d, "owner": "prune-suite",
            "created_utc": created, "until_utc": now + until_s})   # epoch seconds, as lease_ref3/4 write them
        with open(os.path.join(leases, LEASE_KEY(st) + ".reserve.json"), "w") as f:
            f.write(body)
    finally:
        fcntl.flock(b, fcntl.LOCK_UN); os.close(b)


@case("a live RESERVE on staged inputs (no process) protects them; control deleted")
def c08_reserve_live(sb, prune):
    L = sb.laptop(); ctl = control(sb, L); d = sb.project(L, "p1", "downloads"); tree_bytes(d)
    reserve(sb, d, until_s=6 * 3600)
    rc, rows, _ = sb.run(prune, sb.config(live=True), "--pass", "high-water", "--live")
    expect(os.path.exists(os.path.join(d, "f0.bin")), "reserved staged inputs deleted")
    reasons = sum((r.get("reasons", []) for r in rows_for(rows, d)), [])
    expect("reserved" in reasons and "lease_unknown" not in reasons, f"reasons {reasons}, want reserved (not unknown)")
    expect_control(ctl)


@case("a live RESERVE on a descendant protects the whole candidate")
def c08b_reserve_descendant(sb, prune):
    L = sb.laptop(); ctl = control(sb, L); d = sb.project(L, "p1"); tree_bytes(d)
    inner = os.path.join(d, "sub"); reserve(sb, inner, until_s=6 * 3600); age_tree(d, 10)
    rc, rows, _ = sb.run(prune, sb.config(live=True), "--pass", "high-water", "--live")
    reasons = sum((r.get("reasons", []) for r in rows_for(rows, d)), [])
    expect("reserved" in reasons and "lease_unknown" not in reasons, f"reasons {reasons}, want reserved (not unknown)")
    expect(os.path.exists(os.path.join(inner, "deep.o")), "candidate with a reserved descendant deleted")
    expect_control(ctl)


@case("a malformed, inverted or over-24h RESERVE means UNKNOWN: skip, never delete")
def c08c_reserve_bad(sb, prune):
    L = sb.laptop(); ctl = control(sb, L)
    bad = sb.project(L, "bad"); tree_bytes(bad); reserve(sb, bad, raw="{not json")
    far = sb.project(L, "far"); tree_bytes(far); reserve(sb, far, until_s=48 * 3600)
    inv = sb.project(L, "inv"); tree_bytes(inv)
    t = time.time()
    reserve(sb, inv, raw=json.dumps({"version": 1, "path": inv, "owner": "prune-suite",   # until before created
                                     "created_utc": t, "until_utc": t - 3600}))
    sb.run(prune, sb.config(live=True), "--pass", "high-water", "--live")
    expect(os.path.exists(os.path.join(bad, "f0.bin")), "malformed reservation treated as free")
    expect(os.path.exists(os.path.join(far, "f0.bin")), "over-24h reservation treated as free")
    expect(os.path.exists(os.path.join(inv, "f0.bin")), "inverted (until < created) reservation treated as free")
    expect_control(ctl)


def reasons_of(rows, d):
    return sum((r.get("reasons", []) for r in rows_for(rows, d)), [])


def raw_reserve(sb, d, body):
    reserve(sb, d, raw=json.dumps({"version": 1, "path": d, "owner": "prune-suite", **body}))


@case("contract r8 §T: future-dated or over-cap reservations are UNKNOWN, never live or expired")
def c08e_reserve_time_rules(sb, prune):
    L = sb.laptop(); ctl = control(sb, L); t = time.time(); bad = {}
    for name, body in {
        "future-created": {"created_utc": t + 120, "until_utc": t + 3600},          # created > now + 60
        "beyond-cap": {"created_utc": t + 30, "until_utc": t + 86400 + 50},         # until - now > 86400
        "numeric-string": {"created_utc": str(t - 60), "until_utc": str(t + 3600)}, # strings are UNKNOWN
        "iso-string": {"created_utc": "2026-10-25T15:00:00Z", "until_utc": "2026-10-25T21:00:00Z"},
        "boolean": {"created_utc": True, "until_utc": t + 3600},
        "zero-length": {"created_utc": t, "until_utc": t},                            # needs 0 < until - created
    }.items():
        d = sb.project(L, name); tree_bytes(d); raw_reserve(sb, d, body); bad[name] = d
    rc, rows, _ = sb.run(prune, sb.config(live=True), "--pass", "high-water", "--live")
    for name, d in bad.items():
        expect(os.path.exists(os.path.join(d, "f0.bin")), f"{name}: reserved tree deleted")
        expect("lease_unknown" in reasons_of(rows, d), f"{name}: reasons {reasons_of(rows, d)}, want lease_unknown")
    expect_control(ctl)


@case("contract r8 §T: a small clock skew (created now + 30 s) is accepted as a LIVE reservation")
def c08f_reserve_small_skew(sb, prune):
    L = sb.laptop(); ctl = control(sb, L); t = time.time(); d = sb.project(L, "p1"); tree_bytes(d)
    raw_reserve(sb, d, {"created_utc": t + 30, "until_utc": t + 3600})
    rc, rows, _ = sb.run(prune, sb.config(live=True), "--pass", "high-water", "--live")
    expect(os.path.exists(os.path.join(d, "f0.bin")), "live reservation with small skew deleted")
    expect("reserved" in reasons_of(rows, d) and "lease_unknown" not in reasons_of(rows, d),
           f"reasons {reasons_of(rows, d)}, want reserved")
    expect_control(ctl)


@case("an EXPIRED RESERVE is only a stale candidate: deletable when every other check passes")
def c08d_reserve_expired(sb, prune):
    L = sb.laptop(); d = sb.project(L, "p1", "downloads"); tree_bytes(d)
    reserve(sb, d, until_s=-3600)
    sb.run(prune, sb.config(live=True), "--pass", "high-water", "--live")
    expect(not os.path.exists(d), "expired reservation still protected the tree (or nothing is deleted)")


@case("a busy admission barrier (an acquisition in progress) makes the janitor skip that laptop's candidates")
def c23_barrier_busy(sb, prune):
    L1 = sb.laptop("L1"); L2 = sb.laptop("L2")
    d = sb.project(L1, "p1"); tree_bytes(d)
    ctl = control(sb, L2)                                   # another laptop: its own barrier, so it must go
    sb.cleanups.append(Holder(d, sb, "L1", mode="barrier-only"))
    sb.run(prune, sb.config(live=True), "--pass", "high-water", "--live")
    expect(os.path.exists(os.path.join(d, "f0.bin")), "deleted while an acquisition held the barrier")
    expect_control(ctl)


@case("a laptop whose lease dir is MISSING is lease_unknown (never created, never deleted); another laptop is pruned")
def c23b_lease_dir_missing(sb, prune):
    L1 = sb.laptop("L1"); L2 = sb.laptop("L2"); ctl = control(sb, L2)
    d = sb.project(L1, "p1"); tree_bytes(d)
    shutil.rmtree(lease_dir(sb, "L1"))
    rc, rows, _ = sb.run(prune, sb.config(live=True), "--pass", "high-water", "--live")
    expect(os.path.exists(os.path.join(d, "f0.bin")), "deleted although its laptop's lease dir is missing")
    expect("lease_unknown" in reasons_of(rows, d), f"reasons {reasons_of(rows, d)}, want lease_unknown")
    expect(not os.path.exists(lease_dir(sb, "L1")), "the prune created a lease dir (it must not)")
    expect_control(ctl)


@case("a laptop whose lease dir is a SYMLINK is lease_unknown; another laptop is pruned")
def c23c_lease_dir_symlink(sb, prune):
    L1 = sb.laptop("L1"); L2 = sb.laptop("L2"); ctl = control(sb, L2)
    d = sb.project(L1, "p1"); tree_bytes(d)
    real = os.path.join(sb.root, "elsewhere-leases"); os.makedirs(real)
    ld = lease_dir(sb, "L1"); shutil.rmtree(ld); os.symlink(real, ld)
    rc, rows, _ = sb.run(prune, sb.config(live=True), "--pass", "high-water", "--live")
    expect(os.path.exists(os.path.join(d, "f0.bin")), "deleted although its lease dir is a symlink")
    expect("lease_unknown" in reasons_of(rows, d), f"reasons {reasons_of(rows, d)}, want lease_unknown")
    expect_control(ctl)


@case("race: a first lease on a descendant during deletion either wins (tree kept) or is refused; never both lose")
def c24_descendant_race(sb, prune):
    L = sb.laptop(); d = sb.project(L, "p1")
    for i in range(40):                                     # enough files that deletion takes a little while
        for j in range(100):
            write(os.path.join(d, f"d{i}", f"f{j}"), b"x")
    inner = os.path.join(d, "d39"); age_tree(d, 10)
    cmd = shlex.split(prune) + ["--config", sb.config(live=True), "--test-root", sb.root, "--run-id", "race", "--pass", "high-water", "--live"]
    janitor = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(0.05)
    h = Holder(inner, sb, wait=False); sb.cleanups.append(h)
    got = h.result(); janitor.wait(timeout=600)
    if got == "held":
        expect(os.path.isdir(inner), "holder reported a held lease, then its dir was deleted under it")
    else:
        expect(got.startswith("refused"), f"holder state {got!r}")
        expect(not os.path.exists(inner), "holder refused but the tree was not deleted (inconsistent)")


@case("two leases on the SAME dir with different owners/ids share one canonical lock: both must go before deletion")
def c04b_same_dir_two_ids(sb, prune):
    L = sb.laptop(); d = sb.project(L, "p1"); tree_bytes(d)
    h1 = Holder(d, sb); h2 = Holder(d, sb); sb.cleanups += [h1, h2]
    sb.run(prune, sb.config(live=True), "--pass", "high-water", "--live")
    expect(os.path.exists(os.path.join(d, "f0.bin")), "deleted with two holders")
    h1.kill()
    sb.run(prune, sb.config(live=True), "--pass", "high-water", "--live")
    expect(os.path.exists(os.path.join(d, "f0.bin")), "deleted while the second holder still held the same dir")
    h2.kill()
    sb.run(prune, sb.config(live=True), "--pass", "high-water", "--live")
    expect(not os.path.exists(d), "still kept after both holders died")


@case("race: a NEW child reservation while the parent is being deleted is either kept or refused, never lost")
def c24b_child_reserve_race(sb, prune):
    L = sb.laptop(); d = sb.project(L, "p1")
    for i in range(40):
        for j in range(100):
            write(os.path.join(d, f"d{i}", f"f{j}"), b"x")
    inner = os.path.join(d, "d39"); age_tree(d, 10)
    cmd = shlex.split(prune) + ["--config", sb.config(live=True), "--test-root", sb.root, "--run-id", "race2", "--pass", "high-water", "--live"]
    janitor = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(0.05)
    h = Holder(inner, sb, mode="reserve", wait=False); sb.cleanups.append(h)
    got = h.result(); janitor.wait(timeout=600)
    if got == "held":
        expect(os.path.isdir(inner), "reservation was written, then its dir was deleted")
    else:
        expect(got.startswith("refused"), f"reserver state {got!r}")


@case("a ZOMBIE process anywhere must not make the whole pass skip (it holds no files)")
def c26b_zombie(sb, prune):
    L = sb.laptop(); d = sb.project(L, "p1"); tree_bytes(d)
    z = subprocess.Popen(["true"]); time.sleep(0.3)   # exited, never reaped: state Z until the case ends
    try:
        sb.run(prune, sb.config(live=True), "--pass", "high-water", "--live")
    finally:
        z.wait()
    expect(not os.path.exists(d), "an unrelated zombie made the prune skip everything (proc_unreadable)")


BIND_EXEC = r"""
import ctypes, os, sys
src, dst = sys.argv[1], sys.argv[2]
uid, gid = os.getuid(), os.getgid()
os.unshare(os.CLONE_NEWUSER | os.CLONE_NEWNS | os.CLONE_NEWPID)   # unprivileged user + mount + pid namespace
with open("/proc/self/setgroups", "w") as f: f.write("deny")
with open("/proc/self/uid_map", "w") as f: f.write(f"{uid} {uid} 1")   # same uid inside: the prune stays unprivileged
with open("/proc/self/gid_map", "w") as f: f.write(f"{gid} {gid} 1")
libc = ctypes.CDLL(None, use_errno=True)
if libc.mount(b"none", b"/", None, 0x4000 | (1 << 18), None) != 0:  # MS_REC|MS_PRIVATE: nothing leaks out
    raise SystemExit(f"make-private failed {ctypes.get_errno()}")
pid = os.fork()                                        # the child is pid 1 of the new pid namespace
if pid:
    _, status = os.waitpid(pid, 0)
    raise SystemExit(os.waitstatus_to_exitcode(status))
if libc.mount(b"proc", b"/proc", b"proc", 0, None) != 0:            # its own /proc: only this namespace's pids
    raise SystemExit(f"proc mount failed {ctypes.get_errno()}")
if libc.mount(src.encode(), dst.encode(), None, 4096, None) != 0:    # MS_BIND: SAME filesystem, SAME st_dev
    raise SystemExit(f"bind failed {ctypes.get_errno()}")
os.execv(sys.argv[3], sys.argv[3:])                    # the prune runs inside, seeing the bind mount
"""


@case("a SAME-FILESYSTEM bind mount inside a candidate is never crossed (st_dev alone can't see it)")
def c15_bind_mount(sb, prune):
    L = sb.laptop(); ctl = control(sb, L); d = sb.project(L, "p1"); tree_bytes(d)
    mnt = os.path.join(d, "mnt"); os.makedirs(mnt)
    victim = os.path.join(sb.root, "victim"); write(os.path.join(victim, "only-copy.txt"), b"keep")
    age_tree(d, 10); age_tree(victim, 10)
    cmd = shlex.split(prune)
    exe = shutil.which(cmd[0]) or cmd[0]
    wrapped = f"{shlex.quote(sys.executable)} -I -c {shlex.quote(BIND_EXEC)} {shlex.quote(victim)} {shlex.quote(mnt)} " \
              f"{shlex.quote(exe)} " + " ".join(shlex.quote(a) for a in cmd[1:])
    rc, rows, r = sb.run(wrapped, sb.config(live=True), "--pass", "high-water", "--live")
    if any(k in r.stderr for k in ("bind failed", "make-private failed", "proc mount failed")) or "unshare" in r.stderr.lower():
        raise Fail("HOST: this laptop can't create a user+mount namespace: " + r.stderr[-200:])
    expect(os.path.exists(os.path.join(victim, "only-copy.txt")), "the prune deleted files THROUGH a same-fs bind mount")
    expect_control(ctl)


@case("unreadable /proc entries make the pass fail closed", host=True)
def c26_proc_fail_closed(sb, prune):
    raise Fail("HOST: needs another user's processes")


@case("a container's live build is seen from the host janitor", host=True)
def c27_cross_container(sb, prune):
    raise Fail("HOST: proposal 6.7 negative test")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--prune", required=True)
    ap.add_argument("--work", required=True)
    ap.add_argument("--only", default="")
    ap.add_argument("--keep", action="store_true")
    ap.add_argument("--lease-lib", default="", help="lease library the prune loads (config key lease_lib), e.g. lease.py")
    ap.add_argument("--extra", action="append", default=[], help="KEY=JSON added to every config (e.g. test_unbound_ok=true)")
    a = ap.parse_args()
    if a.lease_lib:
        CONFIG_EXTRA["lease_lib"] = os.path.realpath(a.lease_lib)
    for kv in a.extra:
        k, v = kv.split("=", 1)
        CONFIG_EXTRA[k] = json.loads(v)
    work = os.path.realpath(a.work)
    if not work.startswith("/tmp/") or os.path.exists(work):
        sys.exit(f"--work must be a NEW path under /tmp: {work}")
    os.makedirs(work)
    results = []
    for name, tag, host, fn in CASES:
        if a.only and a.only not in name:
            continue
        if host:
            results.append((name, "NOT RUN (host)", tag)); continue
        sb = Sandbox(work, name)
        try:
            fn(sb, a.prune); results.append((name, "PASS", tag))
        except Fail as e:
            results.append((name, f"FAIL: {e}", tag))
        except Exception as e:  # a crash in the fixture or the prune is a failure, never a pass
            results.append((name, f"ERROR: {type(e).__name__}: {e}", tag))
        finally:
            sb.close()
    for n, r, t in results:
        print(f"{r[:4]:4} {n:24} {t}" + ("" if r in ("PASS",) else f"\n     {r}"))
    bad = [r for r in results if not (r[1] == "PASS" or r[1].startswith("NOT RUN"))]
    print(f"\n{len(results) - len(bad)}/{len(results)} pass or host-only; {len(bad)} failing")
    if not a.keep:
        shutil.rmtree(work)
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
