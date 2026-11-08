//! The actual pinned init's executable, joined to the sealed root inode and
//! compile-bound code bytes. A pathname/configuration string is insufficient.
use super::*;
use sha2::{Digest, Sha256};
use std::{
    fs::{File, OpenOptions},
    io::Read,
    os::{
        fd::AsRawFd,
        unix::fs::{MetadataExt, OpenOptionsExt},
    },
    path::PathBuf,
};
const MAX_INIT_BYTES: usize = 64 * 1024 * 1024;

pub(super) fn verify(
    root: &File,
    runtime: &WorkerRuntime,
    pid: u32,
    digest: &str,
    end: Instant,
) -> Result<()> {
    check(runtime, end)?;
    let kernel = PathBuf::from(format!("/proc/{pid}/exe"));
    let named = PathBuf::from(format!(
        "/proc/self/fd/{}/bin/reverie-worker-init",
        root.as_raw_fd()
    ));
    // This intentional kernel magic-link open reads the executable of the
    // SAME pidfd-pinned init. It never selects a program to run or signal.
    let mut executable = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_CLOEXEC | libc::O_NONBLOCK)
        .open(&kernel)?;
    let body = observe(&mut executable, &kernel, &named, runtime, digest, end);
    finalized(body, native::close(executable).map_err(Into::into))
}
fn observe(
    file: &mut File,
    kernel: &Path,
    named: &Path,
    runtime: &WorkerRuntime,
    digest: &str,
    end: Instant,
) -> Result<()> {
    let before = file.metadata()?;
    let expected = std::fs::symlink_metadata(named)?;
    need(
        before.is_file()
            && expected.is_file()
            && before.uid() == 0
            && before.mode() & 0o022 == 0
            && before.mode() & 0o111 != 0
            && before.len() <= MAX_INIT_BYTES as u64
            && native::Stamp::of(&before) == native::Stamp::of(&expected),
        "TASK_PERF_ACTUAL_INIT_CODE",
    )?;
    let mut bytes = Vec::new();
    (&mut *file)
        .take((MAX_INIT_BYTES + 1) as u64)
        .read_to_end(&mut bytes)?;
    let after = file.metadata()?;
    let current = std::fs::metadata(kernel)?;
    let named = std::fs::symlink_metadata(named)?;
    let stamp = native::Stamp::of(&before);
    need(
        bytes.len() as u64 == before.len()
            && bytes.len() <= MAX_INIT_BYTES
            && stamp == native::Stamp::of(&after)
            && stamp == native::Stamp::of(&current)
            && stamp == native::Stamp::of(&named)
            && format!("{:x}", Sha256::digest(&bytes)) == digest,
        "TASK_PERF_ACTUAL_INIT_CHANGED",
    )?;
    check(runtime, end)
}
