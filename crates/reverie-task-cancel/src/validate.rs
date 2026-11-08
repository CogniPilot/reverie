//! Input validation for the task-cancel controller. It starts nothing: the private pins file,
//! the immutable tool and component closure, the reviewed fixture sources, the controller's own
//! executable, the Python lease closure the inner fixture still uses, the private task root and
//! the CPU set the controller is bound to.
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::fs;
use std::io::Read;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Component, Path, PathBuf};
#[cfg(test)]
mod tests;

/// The fixture files the controller runs, under `scripts/acceptance`.
pub(crate) const FIXTURE_FILES: [&str; 3] = [
    "task-cancel-native.py",
    "task-cancel-authority.mjs",
    "task-cancel-program.py",
];
/// The Python lease closure the inner fixture imports.
pub(crate) const LEASE_FILES: [&str; 4] = [
    "python/reverie/__init__.py",
    "python/reverie/workspaces.py",
    "python/reverie/lease.py",
    "python/reverie/cleanup/lease.py",
];
/// The fixed tool closure.
pub(crate) const TOOLS: [&str; 6] = [
    "python",
    "node",
    "systemctl",
    "flock",
    "systemd-run",
    "taskset",
];

pub(crate) type Result<T> = std::result::Result<T, String>;

pub(crate) fn need(condition: bool, message: &str) -> Result<()> {
    if condition {
        Ok(())
    } else {
        Err(message.to_owned())
    }
}

/// This process's user, as the owner of its own /proc entry.
fn own_uid() -> Result<u32> {
    Ok(fs::metadata("/proc/self")
        .map_err(|error| error.to_string())?
        .uid())
}

pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub(crate) fn hex(text: &str, length: usize) -> bool {
    text.len() == length
        && text
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

/// Where immutable inputs must live, and who must own them: `/nix/store` and
/// root in production.
#[derive(Clone, Debug)]
pub(crate) struct Closure {
    pub(crate) store: PathBuf,
    pub(crate) owner: u32,
}
impl Closure {
    pub(crate) fn nix() -> Self {
        Self {
            store: PathBuf::from("/nix/store"),
            owner: 0,
        }
    }
}

/// Read a private metadata file: a canonical absolute path to a regular file
/// this user owns, mode 0600, one link, at most `limit` bytes, unchanged while
/// it was read.
pub(crate) fn read_private(path: &Path, limit: u64) -> Result<Vec<u8>> {
    need(
        path.is_absolute() && fs::canonicalize(path).ok().as_deref() == Some(path),
        "canonical private metadata required",
    )?;
    let mut file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
        .open(path)
        .map_err(|error| format!("private metadata unreadable: {error}"))?;
    let before = file.metadata().map_err(|error| error.to_string())?;
    need(
        before.file_type().is_file()
            && before.uid() == own_uid()?
            && before.nlink() == 1
            && before.mode() & 0o7777 == 0o600
            && before.size() <= limit,
        "bounded own 0600 metadata required",
    )?;
    let mut raw = Vec::new();
    file.by_ref()
        .take(limit + 1)
        .read_to_end(&mut raw)
        .map_err(|error| error.to_string())?;
    let stamp = |m: &fs::Metadata| {
        (
            m.dev(),
            m.ino(),
            m.size(),
            m.mtime(),
            m.mtime_nsec(),
            m.ctime(),
            m.ctime_nsec(),
        )
    };
    let after = file.metadata().map_err(|error| error.to_string())?;
    let named = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    need(
        raw.len() as u64 == before.size()
            && stamp(&before) == stamp(&after)
            && stamp(&after) == stamp(&named),
        "private metadata changed",
    )?;
    Ok(raw)
}

/// Check an immutable closure file: under the store, a regular file owned by
/// the closure owner with no write bits, at most `limit` bytes, with the
/// expected sha256.
pub(crate) fn immutable_bytes(
    closure: &Closure,
    path: &Path,
    expected: &str,
    limit: u64,
) -> Result<()> {
    let resolved = fs::canonicalize(path)
        .map_err(|_| format!("immutable closure file missing: {}", path.display()))?;
    let item = fs::metadata(&resolved).map_err(|error| error.to_string())?;
    need(
        resolved.starts_with(&closure.store)
            && item.file_type().is_file()
            && item.uid() == closure.owner
            && item.mode() & 0o222 == 0
            && item.size() <= limit,
        "immutable bounded closure file required",
    )?;
    let bytes = fs::read(&resolved).map_err(|error| error.to_string())?;
    need(
        sha256_hex(&bytes) == expected,
        "immutable closure file bytes differ",
    )
}

/// The private CPU list: one to eight distinct non-negative integers.
pub(crate) fn cpu_set(value: &Value) -> Result<Vec<usize>> {
    let message = "private finite unique CPU list required";
    let list = value.as_array().ok_or_else(|| message.to_owned())?;
    need((1..=8).contains(&list.len()), message)?;
    let mut cpus = Vec::new();
    for item in list {
        let cpu = item
            .as_u64()
            .filter(|_| item.is_u64())
            .ok_or_else(|| message.to_owned())?;
        cpus.push(usize::try_from(cpu).map_err(|_| message.to_owned())?);
    }
    need(
        cpus.iter().collect::<BTreeSet<_>>().len() == cpus.len(),
        message,
    )?;
    Ok(cpus)
}

/// The CPUs this process may run on, from `Cpus_allowed_list` in /proc/self/status.
pub(crate) fn current_affinity() -> Result<BTreeSet<usize>> {
    let status = fs::read_to_string("/proc/self/status").map_err(|error| error.to_string())?;
    let list = status
        .lines()
        .find_map(|line| line.strip_prefix("Cpus_allowed_list:"))
        .ok_or_else(|| "CPU affinity unavailable".to_owned())?;
    let parse = |text: &str| {
        text.trim()
            .parse::<usize>()
            .map_err(|_| "CPU affinity unreadable".to_owned())
    };
    let mut cpus = BTreeSet::new();
    for range in list.trim().split(',') {
        let (low, high) = range.split_once('-').unwrap_or((range, range));
        cpus.extend(parse(low)?..=parse(high)?);
    }
    Ok(cpus)
}

/// The inputs `validate` checks against.
#[derive(Clone, Debug)]
pub(crate) struct Inputs {
    pub(crate) pins: PathBuf,
    pub(crate) pins_sha256: String,
    pub(crate) lease_root: PathBuf,
    /// The repository checkout holding the fixture and lease sources.
    pub(crate) source: PathBuf,
    /// The running controller executable (`/proc/self/exe` in production).
    pub(crate) executable: PathBuf,
    pub(crate) closure: Closure,
    /// Source-only check: a pending operation id is allowed.
    pub(crate) source_only: bool,
}

/// What validation accepted.
#[derive(Debug)]
pub(crate) struct Validated {
    pub(crate) pins: Map<String, Value>,
    pub(crate) cpus: Vec<usize>,
}

fn string_map<'a>(pins: &'a Map<String, Value>, key: &str) -> Result<&'a Map<String, Value>> {
    pins.get(key)
        .and_then(Value::as_object)
        .ok_or_else(|| format!("pins field {key} must be an object"))
}
fn sha_of<'a>(map: &'a Map<String, Value>, key: &str) -> Result<&'a str> {
    map.get(key)
        .and_then(Value::as_str)
        .filter(|text| hex(text, 64))
        .ok_or_else(|| format!("sha256 for {key} required"))
}
fn keys(map: &Map<String, Value>) -> BTreeSet<&str> {
    map.keys().map(String::as_str).collect()
}
fn module_name(name: &str, extension: &str, flat: bool) -> bool {
    let path = Path::new(name);
    !name.is_empty()
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_./-".contains(&byte))
        && name.ends_with(extension)
        && !path.is_absolute()
        && !path
            .components()
            .any(|part| matches!(part, Component::ParentDir))
        && (!flat || !name.contains('/'))
}

/// Validate the controller's inputs before anything is started.
pub(crate) fn validate(inputs: &Inputs) -> Result<Validated> {
    need(
        hex(&inputs.pins_sha256, 64),
        "reviewed raw pin digest required",
    )?;
    let pins_path =
        fs::canonicalize(&inputs.pins).map_err(|_| "private pins missing".to_owned())?;
    let raw = read_private(&pins_path, 262_144)?;
    need(
        sha256_hex(&raw) == inputs.pins_sha256,
        "private pins changed",
    )?;
    let pins: Map<String, Value> = serde_json::from_slice(&raw)
        .map_err(|_| "private pins are not a JSON object".to_owned())?;
    if !inputs.source_only {
        let id = pins
            .get("operationId")
            .and_then(Value::as_str)
            .unwrap_or("");
        need(
            hex(id, 32),
            "fresh reviewed operation ID required; pending inputs refuse",
        )?;
    }
    sources(inputs, &pins)?;
    tool_closure(inputs, &pins)?;
    component_closure(inputs, &pins)?;
    let lease_root =
        fs::canonicalize(&inputs.lease_root).map_err(|_| "private task required".to_owned())?;
    let item = fs::symlink_metadata(&lease_root).map_err(|error| error.to_string())?;
    need(
        item.uid() == own_uid()? && item.is_dir() && item.mode() & 0o7777 == 0o700,
        "private task required",
    )?;
    let cpus = cpu_set(pins.get("cpuSet").unwrap_or(&Value::Null))?;
    let allowed: BTreeSet<usize> = cpus.iter().copied().collect();
    need(
        current_affinity()?.is_subset(&allowed),
        "controller CPU binding differs from private pins",
    )?;
    Ok(Validated { pins, cpus })
}

/// The reviewed fixture sources, the controller executable and the Python lease
/// closure, each unchanged from the pins.
fn sources(inputs: &Inputs, pins: &Map<String, Value>) -> Result<()> {
    let scripts = string_map(pins, "scripts")?;
    need(
        keys(scripts) == FIXTURE_FILES.into_iter().collect(),
        "closed fixture source set required",
    )?;
    for name in FIXTURE_FILES {
        let path = inputs.source.join("scripts/acceptance").join(name);
        let bytes = fs::read(path).map_err(|error| error.to_string())?;
        need(
            sha256_hex(&bytes) == sha_of(scripts, name)?,
            "reviewed fixture source differs",
        )?;
    }
    let controller = pins
        .get("controllerSHA256")
        .and_then(Value::as_str)
        .filter(|text| hex(text, 64));
    let executable = fs::read(&inputs.executable).map_err(|error| error.to_string())?;
    need(
        controller == Some(sha256_hex(&executable).as_str()),
        "controller executable differs from private pins",
    )?;
    let lease = string_map(pins, "leaseFiles")?;
    need(
        keys(lease) == LEASE_FILES.into_iter().collect()
            && std::env::var_os("REVERIE_LEASE_LIB").is_none(),
        "canonical lease closure required",
    )?;
    for name in LEASE_FILES {
        let bytes = fs::read(inputs.source.join(name)).map_err(|error| error.to_string())?;
        need(
            sha256_hex(&bytes) == sha_of(lease, name)?,
            "canonical lease source differs",
        )?;
    }
    Ok(())
}

/// The fixed tool closure: immutable executables in the store with their pinned bytes.
fn tool_closure(inputs: &Inputs, pins: &Map<String, Value>) -> Result<()> {
    let tools = string_map(pins, "tools")?;
    let tool_shas = string_map(pins, "toolSHA256")?;
    let expected: BTreeSet<&str> = TOOLS.into_iter().collect();
    need(
        keys(tools) == expected && keys(tool_shas) == expected,
        "fixed immutable tool closure required",
    )?;
    for name in TOOLS {
        let path = PathBuf::from(
            tools[name]
                .as_str()
                .ok_or_else(|| format!("tool path for {name} required"))?,
        );
        let item = fs::metadata(&path).map_err(|_| format!("tool {name} missing"))?;
        need(
            path.starts_with(&inputs.closure.store)
                && fs::canonicalize(&path).ok().as_deref() == Some(path.as_path())
                && item.file_type().is_file()
                && item.uid() == inputs.closure.owner
                && item.mode() & 0o222 == 0
                && item.mode() & 0o111 != 0,
            "immutable tool custody differs",
        )?;
        immutable_bytes(
            &inputs.closure,
            &path,
            sha_of(tool_shas, name)?,
            268_435_456,
        )?;
    }
    Ok(())
}

/// The component modules the fixture loads, under the pinned hands and console outputs.
fn component_closure(inputs: &Inputs, pins: &Map<String, Value>) -> Result<()> {
    for (kind, base_key, below, extension, flat) in [
        ("consumerModules", "hands", "", ".py", true),
        (
            "consoleModules",
            "console",
            "lib/reverie/dist",
            ".js",
            false,
        ),
    ] {
        let base =
            PathBuf::from(pins.get(base_key).and_then(Value::as_str).unwrap_or("")).join(below);
        let modules = string_map(pins, kind)?;
        need(
            base.starts_with(&inputs.closure.store)
                && fs::canonicalize(&base).ok().as_deref() == Some(base.as_path())
                && (1..=64).contains(&modules.len()),
            "fixed immutable component closure required",
        )?;
        for name in modules.keys() {
            need(
                module_name(name, extension, flat),
                "component module path differs",
            )?;
            immutable_bytes(
                &inputs.closure,
                &base.join(name),
                sha_of(modules, name)?,
                8_388_608,
            )?;
        }
    }
    Ok(())
}
