//! Root-owned, one-connection memory.high helper. Requests carry identities only.
//! No retry is permitted after the writer has been opened.
#![cfg(target_os = "linux")]

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::ffi::OsStr;
use std::fs;
use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, OwnedFd};
use std::os::unix::fs::MetadataExt;
use std::os::unix::net::UnixStream;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

mod os;
use os::{close, metadata, open_at, peer_uid, read_fd};

const MIB: u64 = 1_048_576;
const REQUEST_MAX: usize = 512;
const POLICY_MAX: usize = 65_536;
const ENGINE_MAX: usize = 65_536;
const INSPECT_FORMAT: &str = "{\"Id\":{{json .Id}},\"Name\":{{json .Name}},\"Config\":{\"Labels\":{{json .Config.Labels}}},\"State\":{\"Running\":{{json .State.Running}},\"Pid\":{{json .State.Pid}}},\"Mounts\":{{json .Mounts}},\"HostConfig\":{\"Memory\":{{json .HostConfig.Memory}}}}";

#[derive(Debug, PartialEq)]
enum Failure {
    Refused(&'static str),
    Unconfirmed,
}
type Result<T> = std::result::Result<T, Failure>;
fn need(value: bool, code: &'static str) -> Result<()> {
    if value {
        Ok(())
    } else {
        Err(Failure::Refused(code))
    }
}
fn identity<T>(value: io::Result<T>) -> Result<T> {
    value.map_err(|_| Failure::Refused("IDENTITY_MISMATCH"))
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    v: u32,
    #[serde(rename = "sessionId")]
    session: String,
    #[serde(rename = "containerId")]
    container: String,
}
fn uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_digit() || (b'a'..=b'f').contains(&b)
            }
        })
}
fn deployment(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 40
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}
fn canonical_absolute(value: &str) -> bool {
    let path = Path::new(value);
    path.is_absolute()
        && !value.as_bytes().contains(&0)
        && path
            .components()
            .all(|c| matches!(c, Component::RootDir | Component::Normal(_)))
        && path.components().collect::<PathBuf>().as_os_str() == path.as_os_str()
}
fn parse_request(raw: &[u8]) -> Result<Request> {
    need(
        !raw.is_empty()
            && raw.len() <= REQUEST_MAX
            && raw.last() == Some(&b'\n')
            && raw.iter().filter(|b| **b == b'\n').count() == 1,
        "REQUEST_INVALID",
    )?;
    let request: Request = serde_json::from_slice(&raw[..raw.len() - 1])
        .map_err(|_| Failure::Refused("REQUEST_INVALID"))?;
    need(
        request.v == 1
            && uuid(&request.session)
            && request.container.len() == 64
            && request
                .container
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
        "REQUEST_INVALID",
    )?;
    Ok(request)
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Policy {
    v: u32,
    deployment: String,
    state_root: String,
    qualified_kernel: Kernel,
    entries: Vec<Entry>,
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Kernel {
    osrelease: String,
}
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Entry {
    employee_id: String,
    home: String,
    #[serde(rename = "memoryMaxMiB")]
    max: u64,
    #[serde(rename = "memoryHighMiB")]
    high: u64,
}
fn validate_policy(policy: Policy) -> Result<Policy> {
    need(
        policy.v == 1 && deployment(&policy.deployment) && canonical_absolute(&policy.state_root),
        "POLICY_INVALID",
    )?;
    let release = &policy.qualified_kernel.osrelease;
    need(
        !release.is_empty()
            && release.len() <= 64
            && release
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._+-".contains(&b)),
        "POLICY_INVALID",
    )?;
    need(policy.entries.len() <= 256, "POLICY_INVALID")?;
    let mut homes = BTreeSet::new();
    for entry in &policy.entries {
        let expected = Path::new(&policy.state_root)
            .join("employees")
            .join(&entry.employee_id)
            .join("home");
        need(
            uuid(&entry.employee_id)
                && expected.as_os_str() == OsStr::new(&entry.home)
                && entry.high >= 512
                && entry.high < entry.max
                && entry.max <= 1_048_576
                && homes.insert(&entry.home),
            "POLICY_INVALID",
        )?;
    }
    Ok(policy)
}

fn read_bounded(path: &Path, maximum: usize) -> io::Result<Vec<u8>> {
    let fd = open_at(
        libc::AT_FDCWD,
        path.as_os_str(),
        libc::O_RDONLY | libc::O_NONBLOCK,
    )?;
    let raw = read_fd(&fd, maximum);
    let closed = close(fd);
    closed.and(raw)
}
fn trusted(meta: &fs::Metadata, uid: u32) -> bool {
    (meta.uid() == 0 || meta.uid() == uid) && meta.mode() & 0o022 == 0
}
fn load_policy(path: &Path, anchor: &Path, uid: u32) -> Result<Policy> {
    let untrusted = |_| Failure::Refused("POLICY_UNTRUSTED");
    need(
        path.is_absolute()
            && path != anchor
            && path.starts_with(anchor)
            && canonical_absolute(path.to_str().unwrap_or("")),
        "POLICY_UNTRUSTED",
    )?;
    let mut parent = open_at(
        libc::AT_FDCWD,
        anchor.as_os_str(),
        libc::O_RDONLY | libc::O_DIRECTORY,
    )
    .map_err(untrusted)?;
    let parts: Vec<_> = path
        .strip_prefix(anchor)
        .map_err(|_| Failure::Refused("POLICY_UNTRUSTED"))?
        .components()
        .collect();
    for part in &parts[..parts.len() - 1] {
        let info = metadata(&parent).map_err(untrusted)?;
        need(info.is_dir() && trusted(&info, uid), "POLICY_UNTRUSTED")?;
        let child = open_at(
            parent.as_raw_fd(),
            part.as_os_str(),
            libc::O_RDONLY | libc::O_DIRECTORY,
        )
        .map_err(untrusted)?;
        close(parent).map_err(untrusted)?;
        parent = child;
    }
    let info = metadata(&parent).map_err(untrusted)?;
    need(info.is_dir() && trusted(&info, uid), "POLICY_UNTRUSTED")?;
    let file = open_at(
        parent.as_raw_fd(),
        parts.last().unwrap().as_os_str(),
        libc::O_RDONLY | libc::O_NONBLOCK,
    )
    .map_err(untrusted)?;
    close(parent).map_err(untrusted)?;
    let before = metadata(&file).map_err(untrusted)?;
    need(
        before.is_file() && trusted(&before, uid) && before.len() <= POLICY_MAX as u64,
        "POLICY_UNTRUSTED",
    )?;
    let raw = read_fd(&file, POLICY_MAX).map_err(untrusted)?;
    let after = metadata(&file).map_err(untrusted)?;
    need(
        raw.len() as u64 == before.len() && stamp(&before) == stamp(&after),
        "POLICY_UNTRUSTED",
    )?;
    close(file).map_err(untrusted)?;
    validate_policy(serde_json::from_slice(&raw).map_err(|_| Failure::Refused("POLICY_INVALID"))?)
}
fn stamp(info: &fs::Metadata) -> (u64, u64, u64, i64, i64, i64, i64) {
    (
        info.dev(),
        info.ino(),
        info.len(),
        info.mtime(),
        info.mtime_nsec(),
        info.ctime(),
        info.ctime_nsec(),
    )
}
fn check_kernel(policy: &Policy, proc: &Path) -> Result<()> {
    let raw = read_bounded(&proc.join("sys/kernel/osrelease"), 128)
        .map_err(|_| Failure::Refused("KERNEL_UNQUALIFIED"))?;
    need(
        raw.is_ascii()
            && std::str::from_utf8(&raw).ok().map(str::trim)
                == Some(&policy.qualified_kernel.osrelease),
        "KERNEL_UNQUALIFIED",
    )
}
fn check_host_root(proc: &Path, cgroup: &Path) -> Result<()> {
    let raw = read_bounded(&proc.join("self/mountinfo"), 1_048_576)
        .map_err(|_| Failure::Refused("HOST_HIERARCHY_REQUIRED"))?;
    let text = String::from_utf8_lossy(&raw);
    let mut found = Vec::new();
    for line in text.lines() {
        let fields: Vec<_> = line.split_whitespace().collect();
        if fields.len() > 6
            && Some(fields[4]) == cgroup.to_str()
            && let Some(separator) = fields.iter().position(|f| *f == "-")
            && let Some(kind) = fields.get(separator + 1)
        {
            found.push((fields[3], *kind));
        }
    }
    need(found == [("/", "cgroup2")], "HOST_HIERARCHY_REQUIRED")
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "PascalCase")]
struct EngineRow {
    id: String,
    name: String,
    config: EngineConfig,
    state: EngineState,
    mounts: Vec<Mount>,
    host_config: HostConfig,
}
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "PascalCase")]
struct EngineConfig {
    labels: BTreeMap<String, String>,
}
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "PascalCase")]
struct EngineState {
    running: bool,
    pid: u32,
}
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "PascalCase")]
struct Mount {
    #[serde(rename = "Type")]
    kind: String,
    source: String,
    destination: String,
}
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "PascalCase")]
struct HostConfig {
    memory: u64,
}
fn no_symlinks(path: &Path) -> bool {
    let mut current = PathBuf::from("/");
    for part in path.components().skip(1) {
        current.push(part);
        if fs::symlink_metadata(&current)
            .map(|m| m.file_type().is_symlink())
            .unwrap_or(true)
        {
            return false;
        }
    }
    true
}
fn select_entry<'a>(policy: &'a Policy, row: &EngineRow, request: &Request) -> Result<&'a Entry> {
    need(
        row.id == request.container
            && row.name == format!("/{}-agent-{}", policy.deployment, request.session)
            && row.config.labels.get("reverie.worker") == Some(&policy.deployment)
            && row.config.labels.get("reverie.session") == Some(&request.session)
            && row.state.running
            && row.state.pid > 0,
        "IDENTITY_MISMATCH",
    )?;
    let mounts: Vec<_> = row
        .mounts
        .iter()
        .filter(|m| m.destination == "/home/agent")
        .collect();
    need(
        mounts.len() == 1 && mounts[0].kind == "bind",
        "POLICY_NO_MATCH",
    )?;
    let entries: Vec<_> = policy
        .entries
        .iter()
        .filter(|e| e.home == mounts[0].source)
        .collect();
    need(
        entries.len() == 1 && no_symlinks(Path::new(&mounts[0].source)),
        "POLICY_NO_MATCH",
    )?;
    need(
        row.host_config.memory == entries[0].max * MIB,
        "HARD_LIMIT_MISMATCH",
    )?;
    Ok(entries[0])
}
fn pid_start(proc: &Path, pid: u32) -> io::Result<Vec<u8>> {
    let raw = read_bounded(&proc.join(pid.to_string()).join("stat"), 4096)?;
    let end = raw
        .iter()
        .rposition(|b| *b == b')')
        .ok_or(io::ErrorKind::InvalidData)?;
    raw[end + 1..]
        .split(|b| b.is_ascii_whitespace())
        .filter(|s| !s.is_empty())
        .nth(19)
        .map(Vec::from)
        .ok_or_else(|| io::Error::from(io::ErrorKind::InvalidData))
}
fn groups(proc: &Path, pid: u32) -> io::Result<String> {
    let raw = read_bounded(&proc.join(pid.to_string()).join("cgroup"), 4096)?;
    if !raw.is_ascii() {
        return Err(io::ErrorKind::InvalidData.into());
    }
    String::from_utf8(raw).map_err(|_| io::ErrorKind::InvalidData.into())
}
fn walk(root: &Path, relative: &Path) -> io::Result<OwnedFd> {
    let mut fd = open_at(
        libc::AT_FDCWD,
        root.as_os_str(),
        libc::O_RDONLY | libc::O_DIRECTORY,
    )?;
    for part in relative.components() {
        if !matches!(part, Component::Normal(_)) {
            return Err(io::ErrorKind::InvalidData.into());
        }
        let child = open_at(
            fd.as_raw_fd(),
            part.as_os_str(),
            libc::O_RDONLY | libc::O_DIRECTORY,
        )?;
        close(fd)?;
        fd = child;
    }
    Ok(fd)
}
struct Target {
    fd: OwnedFd,
    start: Vec<u8>,
    groups: String,
    relative: PathBuf,
    leaf: (u64, u64),
}
impl Target {
    fn open(pid: u32, proc: &Path, cgroup: &Path) -> Result<Self> {
        let start = identity(pid_start(proc, pid))?;
        let groups = identity(groups(proc, pid))?;
        let lines: Vec<_> = groups.lines().collect();
        need(
            lines.len() == 1 && lines[0].starts_with("0::/"),
            "IDENTITY_MISMATCH",
        )?;
        let relative = PathBuf::from(&lines[0][4..]);
        need(
            !relative.as_os_str().is_empty()
                && !relative.is_absolute()
                && relative
                    .components()
                    .all(|c| matches!(c, Component::Normal(_))),
            "IDENTITY_MISMATCH",
        )?;
        let fd = identity(walk(cgroup, &relative))?;
        let meta = identity(metadata(&fd))?;
        Ok(Self {
            fd,
            start,
            groups,
            relative,
            leaf: (meta.dev(), meta.ino()),
        })
    }
    fn fences(&self, pid: u32, proc: &Path, cgroup: &Path) -> bool {
        let check = || -> io::Result<bool> {
            let current = walk(cgroup, &self.relative)?;
            let meta = metadata(&current)?;
            close(current)?;
            Ok(pid_start(proc, pid)? == self.start
                && groups(proc, pid)? == self.groups
                && (meta.dev(), meta.ino()) == self.leaf)
        };
        check().unwrap_or(false)
    }
    fn read(&self, name: &str) -> Result<String> {
        let child = identity(open_at(
            self.fd.as_raw_fd(),
            OsStr::new(name),
            libc::O_RDONLY | libc::O_NONBLOCK,
        ))?;
        let raw = identity(read_fd(&child, 128))?;
        identity(close(child))?;
        need(raw.is_ascii(), "IDENTITY_MISMATCH")?;
        Ok(String::from_utf8_lossy(&raw).trim().to_owned())
    }
}
fn apply_high<F: FnMut() -> Result<bool>>(
    entry: &Entry,
    pid: u32,
    cgroup: &Path,
    proc: &Path,
    mut recheck: F,
    deadline: Instant,
) -> Result<u64> {
    let target = Target::open(pid, proc, cgroup)?;
    let high = entry.high * MIB;
    let hard = (entry.max * MIB).to_string();
    let mut attempted = false;
    let effect = (|| {
        need(
            recheck()? && target.fences(pid, proc, cgroup),
            "IDENTITY_MISMATCH",
        )?;
        need(target.read("memory.max")? == hard, "HARD_LIMIT_MISMATCH")?;
        need(Instant::now() < deadline, "DEADLINE")?;
        let writer = open_at(
            target.fd.as_raw_fd(),
            OsStr::new("memory.high"),
            libc::O_WRONLY | libc::O_NONBLOCK,
        )
        .map_err(|e| {
            Failure::Refused(
                if matches!(
                    e.raw_os_error(),
                    Some(libc::EACCES | libc::EPERM | libc::EROFS)
                ) {
                    "WRITE_REFUSED"
                } else {
                    "IDENTITY_MISMATCH"
                },
            )
        })?;
        attempted = true;
        let raw = format!("{high}\n");
        // Exactly one syscall: partial writes and EINTR are uncertain, never retried.
        let written = os::write_once(&writer, raw.as_bytes());
        let closed = close(writer);
        if written.ok() != Some(raw.len()) || closed.is_err() {
            return Err(Failure::Unconfirmed);
        }
        if !(recheck()?
            && target.fences(pid, proc, cgroup)
            && target.read("memory.high")? == high.to_string()
            && target.read("memory.max")? == hard)
        {
            return Err(Failure::Unconfirmed);
        }
        Ok(high)
    })();
    let final_close = close(target.fd);
    match (effect, final_close, attempted) {
        (Ok(value), Ok(()), _) => Ok(value),
        (_, _, true) => Err(Failure::Unconfirmed),
        (Err(error), _, false) => Err(error),
        (_, Err(_), false) => Err(Failure::Refused("IDENTITY_MISMATCH")),
    }
}

struct Pins {
    broker_uid: u32,
    deployment: String,
    engine: PathBuf,
    endpoint: String,
    policy: PathBuf,
    state_root: String,
}
fn inspect(pins: &Pins, name: &str, deadline: Instant) -> Result<EngineRow> {
    let until = deadline.min(Instant::now() + Duration::from_secs(3));
    need(Instant::now() < until, "DEADLINE")?;
    let mut child = Command::new(&pins.engine)
        .args(["inspect", "--format", INSPECT_FORMAT, name])
        .env_clear()
        .env("DOCKER_HOST", &pins.endpoint)
        .env("PATH", "/var/empty")
        .env("HOME", "/var/empty")
        .env("DOCKER_CONFIG", "/var/empty")
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_error| {
            #[cfg(test)]
            eprintln!("owned fixture engine spawn failed: {_error}");
            Failure::Refused("IDENTITY_MISMATCH")
        })?;
    let mut stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    let outcome = engine_output(&mut child, &mut stdout, &mut stderr, until);
    // Always reap the owned child; its fixed executable runs in systemd's bounded scope.
    if child.try_wait().ok().flatten().is_none() {
        let _ = child.kill();
    }
    let _ = child.wait();
    outcome
}
fn drain_engine_pipe(stream: &mut impl Read, data: &mut Vec<u8>, until: Instant) -> Result<bool> {
    loop {
        need(Instant::now() < until, "DEADLINE")?;
        let mut raw = [0u8; 4096];
        match stream.read(&mut raw) {
            Ok(0) => return Ok(true),
            Ok(n) => {
                data.extend_from_slice(&raw[..n]);
                need(data.len() <= ENGINE_MAX, "IDENTITY_MISMATCH")?;
            }
            Err(e) if e.kind() == io::ErrorKind::WouldBlock => return Ok(false),
            Err(_) => return Err(Failure::Refused("IDENTITY_MISMATCH")),
        }
    }
}
fn engine_output(
    child: &mut std::process::Child,
    stdout: &mut std::process::ChildStdout,
    stderr: &mut std::process::ChildStderr,
    until: Instant,
) -> Result<EngineRow> {
    for fd in [stdout.as_raw_fd(), stderr.as_raw_fd()] {
        os::nonblocking(fd).map_err(|_| Failure::Refused("IDENTITY_MISMATCH"))?;
    }
    let mut out = Vec::new();
    let mut err = Vec::new();
    let mut done = [false, false];
    loop {
        need(Instant::now() < until, "DEADLINE")?;
        if !done[0] {
            done[0] = drain_engine_pipe(stdout, &mut out, until)?;
        }
        if !done[1] {
            done[1] = drain_engine_pipe(stderr, &mut err, until)?;
        }
        if let Some(status) = child
            .try_wait()
            .map_err(|_| Failure::Refused("IDENTITY_MISMATCH"))?
            && done.iter().all(|v| *v)
        {
            need(status.success(), "IDENTITY_MISMATCH")?;
            return serde_json::from_slice(&out).map_err(|_| Failure::Refused("IDENTITY_MISMATCH"));
        }
        let wait = until
            .saturating_duration_since(Instant::now())
            .as_millis()
            .min(10) as i32;
        os::poll_readable([stdout.as_raw_fd(), stderr.as_raw_fd()], wait);
    }
}
fn read_request(conn: &mut UnixStream, deadline: Instant) -> Result<Request> {
    let until = deadline.min(Instant::now() + Duration::from_secs(1));
    let mut raw = Vec::new();
    loop {
        let remaining = until.saturating_duration_since(Instant::now());
        need(!remaining.is_zero(), "REQUEST_INVALID")?;
        conn.set_read_timeout(Some(remaining))
            .map_err(|_| Failure::Refused("REQUEST_INVALID"))?;
        let mut bytes = [0u8; REQUEST_MAX + 1];
        let n = conn
            .read(&mut bytes[..REQUEST_MAX + 1 - raw.len()])
            .map_err(|_| Failure::Refused("REQUEST_INVALID"))?;
        need(n > 0, "REQUEST_INVALID")?;
        raw.extend_from_slice(&bytes[..n]);
        need(raw.len() <= REQUEST_MAX, "REQUEST_INVALID")?;
        if raw.last() == Some(&b'\n') {
            return parse_request(&raw);
        }
    }
}
#[derive(Debug, Serialize, PartialEq)]
#[serde(untagged)]
enum Reply {
    Success {
        ok: bool,
        #[serde(rename = "memoryHighBytes")]
        high: u64,
    },
    Refusal {
        ok: bool,
        code: &'static str,
    },
}
fn serve(conn: &mut UnixStream, pins: &Pins) -> Reply {
    let host = Host {
        proc: Path::new("/proc"),
        cgroup: Path::new("/sys/fs/cgroup"),
        policy_anchor: Path::new("/"),
        policy_uid: 0,
    };
    reply(run_request(conn, pins, &host, inspect))
}
struct Host<'a> {
    proc: &'a Path,
    cgroup: &'a Path,
    policy_anchor: &'a Path,
    policy_uid: u32,
}
fn run_request<F: FnMut(&Pins, &str, Instant) -> Result<EngineRow>>(
    conn: &mut UnixStream,
    pins: &Pins,
    host: &Host<'_>,
    mut inspector: F,
) -> Result<u64> {
    let deadline = Instant::now() + Duration::from_secs(8);
    need(
        peer_uid(conn).map_err(|_| Failure::Unconfirmed)? == pins.broker_uid,
        "PEER_REFUSED",
    )?;
    let request = read_request(conn, deadline)?;
    let policy = load_policy(&pins.policy, host.policy_anchor, host.policy_uid)?;
    need(
        policy.deployment == pins.deployment && policy.state_root == pins.state_root,
        "POLICY_INVALID",
    )?;
    check_kernel(&policy, host.proc)?;
    check_host_root(host.proc, host.cgroup)?;
    let name = format!("{}-agent-{}", pins.deployment, request.session);
    let row = inspector(pins, &name, deadline)?;
    let entry = select_entry(&policy, &row, &request)?;
    apply_high(
        entry,
        row.state.pid,
        host.cgroup,
        host.proc,
        || {
            let again = inspector(pins, &name, deadline)?;
            Ok(select_entry(&policy, &again, &request)? == entry && again.state == row.state)
        },
        deadline,
    )
}
fn reply(result: Result<u64>) -> Reply {
    match result {
        Ok(high) => Reply::Success { ok: true, high },
        Err(Failure::Refused(code)) => Reply::Refusal { ok: false, code },
        Err(Failure::Unconfirmed) => Reply::Refusal {
            ok: false,
            code: "EFFECT_UNCONFIRMED",
        },
    }
}
fn arguments() -> std::result::Result<Option<Pins>, ()> {
    let mut args = std::env::args().skip(1);
    let mut values = BTreeMap::new();
    while let Some(key) = args.next() {
        if key == "--help" {
            return Ok(None);
        }
        if ![
            "--broker-uid",
            "--deployment",
            "--engine",
            "--endpoint",
            "--policy",
            "--state-root",
        ]
        .contains(&key.as_str())
            || values.contains_key(&key)
        {
            return Err(());
        }
        values.insert(key, args.next().ok_or(())?);
    }
    if values.len() != 6 {
        return Err(());
    }
    let get = |key: &str| values.get(key).unwrap().to_owned();
    let pins = Pins {
        broker_uid: get("--broker-uid").parse().map_err(|_| ())?,
        deployment: get("--deployment"),
        engine: PathBuf::from(get("--engine")),
        endpoint: get("--endpoint"),
        policy: PathBuf::from(get("--policy")),
        state_root: get("--state-root"),
    };
    if !deployment(&pins.deployment)
        || !canonical_absolute(&pins.state_root)
        || !pins.engine.is_absolute()
        || !pins.policy.is_absolute()
    {
        return Err(());
    }
    Ok(Some(pins))
}
fn main() {
    let pins = match arguments() {
        Ok(Some(pins)) => pins,
        Ok(None) => {
            println!(
                "reverie-soft-limit-helper --broker-uid UID --deployment NAME --engine PATH --endpoint URI --policy PATH --state-root PATH"
            );
            return;
        }
        Err(()) => {
            eprintln!("Invalid fixed soft-limit helper arguments; use --help");
            std::process::exit(2);
        }
    };
    let fd = match os::duplicate_stdin() {
        Ok(fd) => fd,
        Err(_) => std::process::exit(1),
    };
    let mut conn = UnixStream::from(fd);
    let reply = serve(&mut conn, &pins);
    if let Ok(mut raw) = serde_json::to_vec(&reply) {
        raw.push(b'\n');
        let _ = conn.set_write_timeout(Some(Duration::from_secs(1)));
        let _ = conn.write_all(&raw);
    }
}

#[cfg(test)]
mod tests;
