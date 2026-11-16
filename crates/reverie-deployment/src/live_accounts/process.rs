//! Denial-only physical account bind join. No namespace entry, input or signal.
use super::*;
use nix::{
    fcntl::{OFlag, open, openat},
    sys::stat::Mode,
};
use std::{
    fs::{self, File, Metadata},
    io::Read,
    path::Component,
};
mod backing;
mod inside;
use inside::Inside;

const BIND: &str = "DEPLOYMENT_LIVE_ACCOUNT_BIND_CHANGED";
const PROCESS: &str = "DEPLOYMENT_LIVE_ACCOUNT_PROCESS_CHANGED";
fn close(file: File) -> Result<()> {
    nix::unistd::close(file).map_err(|_| DeploymentError::new("DEPLOYMENT_BIND_CLOSE_UNCONFIRMED"))
}
fn close_all(files: Vec<File>) -> Result<()> {
    let mut result = Ok(());
    for file in files {
        result = DeploymentError::finalized(result, close(file));
    }
    result
}
fn birth(pid: u64) -> Result<String> {
    let mut text = String::new();
    File::open(format!("/proc/{pid}/stat"))?
        .take(65_537)
        .read_to_string(&mut text)?;
    require(text.len() <= 65_536, INVALID)?;
    reverie_contracts::kernel_accounting::process_start(&text)
        .map_err(|_| DeploymentError::new(INVALID))
}
pub(super) fn valid_namespace(value: &str) -> bool {
    value
        .strip_prefix("mnt:[")
        .and_then(|v| v.strip_suffix(']'))
        .is_some_and(|v| !v.is_empty() && v.len() <= 20 && v.bytes().all(|b| b.is_ascii_digit()))
}
fn namespace(pid: u64) -> Result<String> {
    let value = fs::read_link(format!("/proc/{pid}/ns/mnt"))?;
    let value = value
        .to_str()
        .ok_or_else(|| DeploymentError::new(PROCESS))?;
    require(valid_namespace(value), PROCESS)?;
    Ok(value.into())
}
fn current(expected: &Writer) -> Result<()> {
    require(
        birth(expected.pid)? == expected.process_birth
            && namespace(expected.pid)? == expected.mount_namespace,
        PROCESS,
    )
}
fn same(a: &Metadata, b: &Metadata) -> bool {
    (a.dev(), a.ino(), a.uid(), a.gid(), a.mode()) == (b.dev(), b.ino(), b.uid(), b.gid(), b.mode())
}
fn verify_bind(
    source: &Path,
    console: &Path,
    expected: &Writer,
    destination: &str,
    reobserve: impl FnOnce() -> Result<()>,
) -> Result<()> {
    require(source.is_absolute(), BIND)?;
    let held = ObservedPath::capture(source).map_err(|_| DeploymentError::new(INVALID))?;
    let result = (|| {
        let metadata = fs::metadata(source)?;
        require(metadata.is_dir() || metadata.is_file(), BIND)?;
        require(held.identity() == (metadata.dev(), metadata.ino()), BIND)?;
        current(expected)?;
        let inside = Inside::capture(expected.pid, destination, metadata.is_dir())?;
        let result = (|| {
            let backing = backing::Backing::capture(source, console)?;
            let result = (|| {
                inside.verify(expected.pid, &metadata)?;
                reobserve()?;
                inside.verify(expected.pid, &metadata)?;
                require(same(&fs::metadata(source)?, &metadata), BIND)?;
                backing.verify()?;
                held.verify().map_err(|_| DeploymentError::new(INVALID))?;
                current(expected)
            })();
            DeploymentError::finalized(result, backing.close())
        })();
        DeploymentError::finalized(result, inside.close())
    })();
    DeploymentError::finalized(
        result,
        held.close().map_err(|_| DeploymentError::new(INVALID)),
    )
}
fn host_writer(mount: &Value) -> Result<bool> {
    let writable = mount["RW"]
        .as_bool()
        .ok_or_else(|| DeploymentError::new(INVALID))?;
    if !writable || mount["Type"] == "tmpfs" {
        return Ok(false);
    }
    require(
        matches!(mount["Type"].as_str(), Some("bind" | "volume")),
        INVALID,
    )?;
    Ok(true)
}
pub(super) fn has_host_writer(row: &Value) -> Result<bool> {
    let mounts = row["Mounts"]
        .as_array()
        .ok_or_else(|| DeploymentError::new(INVALID))?;
    let mut writable = false;
    for mount in mounts {
        writable |= host_writer(mount)?;
    }
    Ok(writable)
}
pub(super) fn observe_writer(engine: &Engine, row: &Value, console: &Path) -> Result<Writer> {
    let id = model::cid(model::string(row, "Id")?)?;
    let observed = engine.container(id)?;
    let pid = observed["State"]["Pid"]
        .as_u64()
        .filter(|pid| *pid > 0)
        .ok_or_else(|| DeploymentError::new(INVALID))?;
    let expected = writer(row, &observed, console, birth(pid)?, namespace(pid)?)?;
    let mounts = observed["Mounts"]
        .as_array()
        .ok_or_else(|| DeploymentError::new(INVALID))?;
    for mount in mounts {
        if !host_writer(mount)? {
            continue;
        }
        let source = Path::new(model::string(mount, "Source")?);
        let destination = model::string(mount, "Destination")?;
        verify_bind(source, console, &expected, destination, || {
            let current = engine.container(id)?;
            require(
                writer(row, &current, console, birth(pid)?, namespace(pid)?)? == expected,
                "DEPLOYMENT_LIVE_ACCOUNT_WRITERS_CHANGED",
            )
        })?;
    }
    Ok(expected)
}
