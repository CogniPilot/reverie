use super::*;
use reverie_contracts::resource_actor::{ProcessStatData, require_peer_kernel_status};
use sha2::{Digest, Sha256};
use std::{
    fs::OpenOptions,
    io::Read,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
};

fn path(pid: &UnsignedInteger, leaf: &str) -> String {
    format!("/proc/{}/{leaf}", pid.as_str())
}
pub(super) fn bytes(
    files: &mut Descriptors,
    pid: &UnsignedInteger,
    leaf: &str,
    bound: usize,
    end: Instant,
) -> Result<Vec<u8>> {
    check(end)?;
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK)
        .open(path(pid, leaf))?;
    let index = files.retain(file);
    let mut raw = Vec::new();
    files
        .get_mut(index)
        .take((bound + 1) as u64)
        .read_to_end(&mut raw)?;
    check(end)?;
    Ok(raw)
}
pub(super) fn identity(
    files: &mut Descriptors,
    pid: &UnsignedInteger,
    leaf: &str,
    end: Instant,
) -> Result<[u64; 2]> {
    check(end)?;
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_PATH | libc::O_CLOEXEC)
        .open(path(pid, leaf))?;
    let index = files.retain(file);
    let info = files.get(index).metadata()?;
    check(end)?;
    Ok([info.dev(), info.ino()])
}
pub(super) fn process(
    files: &mut Descriptors,
    pid: &UnsignedInteger,
    end: Instant,
) -> Result<ProcessSnapshot> {
    let raw = bytes(files, pid, "stat", 8192, end)?;
    let stat =
        ProcessStatData::decode(&raw).map_err(|error| WebsiteFactsError::Refused(error.code()))?;
    let argv = bytes(files, pid, "cmdline", 65536, end)?;
    need(!argv.is_empty() && argv.len() <= 65536, "ARGV_BOUND")?;
    let argv = JournalDigest::parse(&format!("{:x}", Sha256::digest(argv))).expect("SHA256");
    let executable = identity(files, pid, "exe", end)?;
    let mut namespaces = [0; 3];
    for (index, name) in ["ns/mnt", "ns/pid", "ns/user"].iter().enumerate() {
        namespaces[index] = identity(files, pid, name, end)?[1];
    }
    Ok(ProcessSnapshot {
        pid: pid.clone(),
        start: stat.start().clone(),
        parent: stat.parent().clone(),
        argv,
        executable,
        namespaces,
    })
}
pub(super) fn status(files: &mut Descriptors, pid: &UnsignedInteger, end: Instant) -> Result<()> {
    let raw = bytes(files, pid, "status", 65536, end)?;
    require_peer_kernel_status(&raw).map_err(|error| WebsiteFactsError::Refused(error.code()))
}
fn check(end: Instant) -> Result<()> {
    need(Instant::now() < end, "PROCESS_DEADLINE")
}
