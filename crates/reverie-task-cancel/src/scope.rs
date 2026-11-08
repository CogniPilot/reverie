//! The systemd scope the controller runs the fixture in: the fixed `systemd-run --user --scope`
//! command, `systemctl --user show` parsing, the owned-scope identity checks, the cgroup-empty
//! check and the owned stop. Every tool call runs with a clean bus environment and is bounded by
//! the controller's absolute deadline.
use crate::validate::{Result, TOOLS, hex, need};
use nix::errno::Errno;
use nix::poll::{PollFd, PollFlags, PollTimeout, poll};
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::ffi::{OsStr, OsString};
use std::fs;
use std::io::{self, Read};
use std::os::fd::AsFd;
use std::path::{Component, Path, PathBuf};
use std::process::{Child, ChildStdout, Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};
#[cfg(test)]
mod tests;

/// The scope's own lifetime, independent of the controller.
pub(crate) const RUNTIME: Duration = Duration::from_secs(120);
/// How long systemd waits for the scope to stop.
pub(crate) const STOP: Duration = Duration::from_secs(30);
/// The controller's whole budget for one run.
pub(crate) const TOTAL: Duration = Duration::from_secs(180);
pub(crate) const MEMORY: u64 = 536_870_912;
pub(crate) const TASKS: u32 = 128;
const QUERY: Duration = Duration::from_secs(3);
const PROPERTIES: &str = "Id,InvocationID,LoadState,ActiveState,SubState,Result,ControlGroup,RuntimeMaxUSec,TimeoutStopUSec,MemoryMax,MemorySwapMax,TasksMax";
const SHOW_LIMIT: usize = 16_384;
/// The only inherited variables the user bus needs.
const BUS_VARIABLES: [&str; 6] = [
    "HOME",
    "USER",
    "LOGNAME",
    "XDG_RUNTIME_DIR",
    "DBUS_SESSION_BUS_ADDRESS",
    "LANG",
];

/// `systemctl --user show` output.
pub(crate) type Properties = BTreeMap<String, String>;

/// The validated tool closure, by name.
#[derive(Clone, Debug)]
pub(crate) struct Tools(BTreeMap<&'static str, PathBuf>);
impl Tools {
    pub(crate) fn from_pins(pins: &Map<String, Value>) -> Result<Self> {
        let tools = pins.get("tools").and_then(Value::as_object);
        let mut paths = BTreeMap::new();
        for name in TOOLS {
            let path = tools
                .and_then(|tools| tools.get(name))
                .and_then(Value::as_str);
            paths.insert(
                name,
                PathBuf::from(path.ok_or_else(|| format!("tool path for {name} required"))?),
            );
        }
        Ok(Self(paths))
    }
    pub(crate) fn get(&self, name: &str) -> &Path {
        &self.0[name]
    }
    /// The clean environment for user-bus tools: the bus variables this process has, and a PATH
    /// of the tool directories only.
    pub(crate) fn bus_environment(&self) -> Result<Vec<(OsString, OsString)>> {
        let mut environment: Vec<(OsString, OsString)> = BUS_VARIABLES
            .into_iter()
            .filter_map(|key| std::env::var_os(key).map(|value| (key.into(), value)))
            .collect();
        let mut directories: Vec<&Path> = Vec::new();
        for name in TOOLS {
            if let Some(directory) = self.get(name).parent()
                && !directories.contains(&directory)
            {
                directories.push(directory);
            }
        }
        let path = std::env::join_paths(directories).map_err(|error| error.to_string())?;
        environment.push(("PATH".into(), path));
        Ok(environment)
    }
}

/// The time left before `deadline`, capped at `maximum`; refuses once the deadline has passed.
pub(crate) fn remaining(deadline: Instant, maximum: Duration) -> Result<Duration> {
    let left = deadline
        .saturating_duration_since(Instant::now())
        .min(maximum);
    need(!left.is_zero(), "absolute outer deadline exhausted")?;
    Ok(left)
}

/// Run systemctl with the clean bus environment and at most `SHOW_LIMIT + 1` bytes of its output
/// kept. One deadline, `timeout` from now, covers both reading its output to the end and its exit,
/// so a descendant that keeps the output open cannot outlast it; the child is killed when it passes.
/// Returns the exit code (-1 for a signal) and the output.
fn systemctl(tools: &Tools, args: &[&str], timeout: Duration) -> Result<(i32, Vec<u8>)> {
    let program = tools.get("systemctl");
    let mut child = Command::new(program)
        .args(args)
        .env_clear()
        .envs(tools.bus_environment()?)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("{} unavailable: {error}", program.display()))?;
    let end = Instant::now() + timeout;
    let mut stdout = child.stdout.take().expect("piped stdout");
    let captured = capture(&mut stdout, end);
    drop(stdout);
    match captured.and_then(|output| exited(&mut child, end).map(|status| (status, output))) {
        Ok((status, output)) => Ok((status.code().unwrap_or(-1), output)),
        Err(reason) => {
            let _ = child.kill();
            let _ = child.wait();
            Err(format!("{} {reason}", program.display()))
        }
    }
}

/// Read `stdout` to its end by `end`, keeping at most `SHOW_LIMIT + 1` bytes.
fn capture(stdout: &mut ChildStdout, end: Instant) -> std::result::Result<Vec<u8>, &'static str> {
    let mut output = Vec::new();
    let mut buffer = [0_u8; 8192];
    loop {
        let left = end.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Err("exceeded its deadline");
        }
        let wait = PollTimeout::try_from(left).unwrap_or(PollTimeout::MAX);
        let mut ready = [PollFd::new(stdout.as_fd(), PollFlags::POLLIN)];
        match poll(&mut ready, wait) {
            Ok(0) | Err(Errno::EINTR) => continue,
            Ok(_) => {}
            Err(_) => return Err("output unreadable"),
        }
        match stdout.read(&mut buffer) {
            Ok(0) => return Ok(output),
            Ok(read) => {
                let keep = (SHOW_LIMIT + 1).saturating_sub(output.len()).min(read);
                output.extend_from_slice(&buffer[..keep]);
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(_) => return Err("output unreadable"),
        }
    }
}

/// The child's exit status by `end`.
fn exited(child: &mut Child, end: Instant) -> std::result::Result<ExitStatus, &'static str> {
    loop {
        if let Some(status) = child.try_wait().map_err(|_| "exit unreadable")? {
            return Ok(status);
        }
        if Instant::now() >= end {
            return Err("exceeded its deadline");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

/// Parse `key=value` lines: every line has a separator and no key repeats.
pub(crate) fn parse_properties(output: &[u8]) -> Result<Properties> {
    let text = std::str::from_utf8(output).map_err(|_| "invalid scope properties".to_owned())?;
    let mut properties = Properties::new();
    for line in text.lines() {
        let (key, value) = line
            .split_once('=')
            .ok_or_else(|| "invalid scope properties".to_owned())?;
        need(
            properties
                .insert(key.to_owned(), value.to_owned())
                .is_none(),
            "invalid scope properties",
        )?;
    }
    Ok(properties)
}

/// `systemctl --user show` for the unit, within three seconds and the absolute deadline.
pub(crate) fn query(tools: &Tools, unit: &str, deadline: Instant) -> Result<(i32, Properties)> {
    let timeout = remaining(deadline, QUERY)?;
    let property = format!("--property={PROPERTIES}");
    let (code, output) = systemctl(tools, &["--user", "show", unit, &property], timeout)?;
    need(output.len() <= SHOW_LIMIT, "scope metadata bound")?;
    Ok((code, parse_properties(&output)?))
}

/// A systemd time span (`2min`, `1min 30s`, `500ms`) in nanoseconds. `None` is a well-formed
/// span that is not a whole number of nanoseconds or does not fit, which is never a pinned value.
pub(crate) fn time_value(text: &str) -> Result<Option<u128>> {
    need(
        !text.is_empty() && text.len() <= 64,
        "finite scope time required",
    )?;
    let unsupported = || "unsupported scope time".to_owned();
    let mut rest = text.trim_start();
    need(!rest.is_empty(), "unsupported scope time")?;
    let mut total: Option<u128> = Some(0);
    while !rest.is_empty() {
        let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
        need(digits > 0, "unsupported scope time")?;
        let (whole, after) = rest.split_at(digits);
        let (fraction, after) = match after.strip_prefix('.') {
            Some(after) => {
                let count = after.bytes().take_while(u8::is_ascii_digit).count();
                need(count > 0, "unsupported scope time")?;
                after.split_at(count)
            }
            None => ("", after),
        };
        let (scale, after) = [
            ("us", 1_000),
            ("ms", 1_000_000),
            ("min", 60_000_000_000),
            ("s", 1_000_000_000),
            ("h", 3_600_000_000_000),
        ]
        .into_iter()
        .find_map(|(unit, scale): (&str, u128)| {
            after.strip_prefix(unit).map(|after| (scale, after))
        })
        .ok_or_else(unsupported)?;
        total = total.and_then(|total| total.checked_add(span(whole, fraction, scale)?));
        rest = after.trim_start();
    }
    Ok(total)
}
/// `whole.fraction` units of `scale` nanoseconds, when that is a whole number that fits.
fn span(whole: &str, fraction: &str, scale: u128) -> Option<u128> {
    let mut value = whole.parse::<u128>().ok()?.checked_mul(scale)?;
    let mut denominator = 1_u128;
    let mut numerator = 0_u128;
    for digit in fraction.bytes() {
        denominator = denominator.checked_mul(10)?;
        numerator = numerator
            .checked_mul(10)?
            .checked_add(u128::from(digit - b'0'))?;
    }
    let part = numerator.checked_mul(scale)?;
    if part % denominator != 0 {
        return None;
    }
    value = value.checked_add(part / denominator)?;
    Some(value)
}

/// The identity of the scope this controller started.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Binding {
    pub(crate) unit: String,
    pub(crate) invocation_id: String,
    pub(crate) control_group: String,
}

fn property<'a>(value: &'a Properties, key: &str) -> &'a str {
    value.get(key).map_or("", String::as_str)
}

/// The fixed unit name for an operation.
pub(crate) fn own_unit(unit: &str) -> bool {
    unit.strip_prefix("reverie-task-cancel-")
        .and_then(|rest| rest.strip_suffix(".scope"))
        .is_some_and(|id| hex(id, 32))
}

/// Capture the actual active scope: its fixed name, its invocation and cgroup, and the
/// independent lifetime and resource limits it was started with.
pub(crate) fn capture_scope(value: &Properties, unit: &str) -> Result<Binding> {
    need(
        own_unit(unit) && property(value, "Id") == unit,
        "wrong own scope",
    )?;
    let invocation = property(value, "InvocationID");
    need(
        property(value, "ActiveState") == "active" && hex(invocation, 32),
        "actual active scope missing",
    )?;
    let group = property(value, "ControlGroup");
    let path = Path::new(group);
    need(
        group.starts_with('/')
            && path.file_name() == Some(OsStr::new(unit))
            && !path
                .components()
                .any(|part| matches!(part, Component::ParentDir)),
        "wrong actual cgroup",
    )?;
    let runtime = time_value(property(value, "RuntimeMaxUSec"))?;
    let stop = time_value(property(value, "TimeoutStopUSec"))?;
    need(
        runtime == Some(RUNTIME.as_nanos()) && stop == Some(STOP.as_nanos()),
        "independent scope lifetime differs",
    )?;
    need(
        property(value, "MemoryMax") == MEMORY.to_string()
            && property(value, "MemorySwapMax") == "0"
            && property(value, "TasksMax") == TASKS.to_string(),
        "scope resource limits differ",
    )?;
    Ok(Binding {
        unit: unit.to_owned(),
        invocation_id: invocation.to_owned(),
        control_group: group.to_owned(),
    })
}

/// The same unit and invocation; the cgroup may already be gone.
pub(crate) fn same_scope(value: &Properties, binding: &Binding) -> bool {
    property(value, "Id") == binding.unit
        && property(value, "InvocationID") == binding.invocation_id
        && [binding.control_group.as_str(), ""].contains(&property(value, "ControlGroup"))
}

/// The captured scope has ended: inactive or failed, and either still the same invocation or
/// unloaded with no invocation or cgroup left.
pub(crate) fn terminal_scope(value: &Properties, binding: &Binding) -> bool {
    let unloaded = property(value, "LoadState") == "not-found"
        && property(value, "InvocationID").is_empty()
        && property(value, "ControlGroup").is_empty();
    property(value, "Id") == binding.unit
        && ["inactive", "failed"].contains(&property(value, "ActiveState"))
        && (same_scope(value, binding) || unloaded)
}

/// Whether the cgroup under `root` (`/sys/fs/cgroup` in production) has no processes: its
/// `cgroup.events` says `populated 0`, or the cgroup no longer exists.
pub(crate) fn cgroup_empty(root: &Path, group: &str) -> Result<bool> {
    let directory = root.join(group.trim_start_matches('/'));
    let text = match fs::read_to_string(directory.join("cgroup.events")) {
        Ok(text) => text,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(!directory.exists()),
        Err(error) => return Err(error.to_string()),
    };
    let mut populated = None;
    for line in text.lines() {
        let fields: Vec<&str> = line.split_whitespace().collect();
        let [key, value] = fields.as_slice() else {
            return Err("invalid cgroup events".to_owned());
        };
        if *key == "populated" {
            populated = Some(*value);
        }
    }
    Ok(populated == Some("0"))
}

/// Stop the captured scope, only after a fresh query shows it is still the same invocation.
pub(crate) fn stop_owned_scope(
    tools: &Tools,
    unit: &str,
    binding: &Binding,
    deadline: Instant,
) -> Result<()> {
    let (_, fresh) = query(tools, unit, deadline)?;
    need(
        same_scope(&fresh, binding),
        "unit changed before owned stop",
    )?;
    let timeout = remaining(deadline, STOP + QUERY)?;
    let (code, _) = systemctl(tools, &["--user", "stop", unit], timeout)?;
    need(code == 0, "owned scope stop failed")
}

/// What one owned fixture run starts inside the scope.
#[derive(Clone, Debug)]
pub(crate) struct Launch<'a> {
    pub(crate) unit: &'a str,
    pub(crate) cpus: &'a [usize],
    /// The checkout holding `scripts/acceptance/task-cancel-native.py`.
    pub(crate) source: &'a Path,
    pub(crate) task: &'a Path,
    pub(crate) pins: &'a Path,
    pub(crate) pins_sha256: &'a str,
    pub(crate) attempt_sha256: &'a str,
}

/// The fixed `systemd-run --user --scope` command: the scope's lifetime and resource limits, the
/// pinned CPU set, and the inner fixture under the pinned Python.
pub(crate) fn scope_command(tools: &Tools, launch: &Launch<'_>) -> Vec<OsString> {
    let cpus: Vec<String> = launch.cpus.iter().map(ToString::to_string).collect();
    let mut command: Vec<OsString> = vec![
        tools.get("systemd-run").into(),
        "--user".into(),
        "--scope".into(),
        "--unit".into(),
        launch.unit.into(),
        format!("--property=RuntimeMaxSec={}", RUNTIME.as_secs()).into(),
        format!("--property=TimeoutStopSec={}", STOP.as_secs()).into(),
        format!("--property=MemoryMax={MEMORY}").into(),
        "--property=MemorySwapMax=0".into(),
        format!("--property=TasksMax={TASKS}").into(),
        tools.get("taskset").into(),
        "-c".into(),
        cpus.join(",").into(),
        tools.get("python").into(),
        "-I".into(),
        "-B".into(),
        launch
            .source
            .join("scripts/acceptance/task-cancel-native.py")
            .into(),
        "--run-owned-fixture".into(),
        "--lease-root".into(),
        launch.task.into(),
        "--pins".into(),
        launch.pins.into(),
    ];
    for (flag, value) in [
        ("--pins-sha256", launch.pins_sha256),
        ("--outer-attempt-sha256", launch.attempt_sha256),
    ] {
        command.push(flag.into());
        command.push(value.into());
    }
    command
}
