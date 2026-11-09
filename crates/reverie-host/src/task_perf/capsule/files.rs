use super::*;
use sha2::{Digest, Sha256};
use std::{
    ffi::OsStr,
    fs::{File, OpenOptions},
    os::{
        fd::AsRawFd,
        unix::fs::{MetadataExt, OpenOptionsExt},
    },
    path::PathBuf,
};

const MAX_CODE_BYTES: usize = 64 * 1024 * 1024;
pub(super) struct Root {
    directory: Option<File>,
}
impl Root {
    pub(super) fn unopened() -> Self {
        Self { directory: None }
    }
    pub(super) fn open(&mut self, runtime: &WorkerRuntime, pid: u32, end: Instant) -> Result<()> {
        check(runtime, end)?;
        need(pid > 1, "TASK_PERF_CAPSULE_PROCESS")?;
        // The sole intentional magic-link traversal is the actual init's
        // kernel-owned root. Every subsequent component is no-follow.
        self.directory = Some(
            OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_DIRECTORY | libc::O_CLOEXEC)
                .open(format!("/proc/{pid}/root"))?,
        );
        for name in ["opt", "reverie", "perf"] {
            check(runtime, end)?;
            let current = self.directory.take().expect("original directory");
            let child = native::open_at(
                current.as_raw_fd(),
                OsStr::new(name),
                libc::O_RDONLY | libc::O_DIRECTORY,
            )
            .map_err(CapsuleError::from);
            let closed = native::close(current).map_err(CapsuleError::from);
            match (child, closed) {
                (Ok(child), Ok(())) => self.directory = Some(child),
                (Err(primary), closed) => return finalized(Err(primary), closed),
                (Ok(child), Err(primary)) => {
                    self.directory = Some(child);
                    return Err(primary);
                }
            }
        }
        let info = self
            .directory
            .as_ref()
            .expect("retained prefix")
            .metadata()?;
        need(
            info.is_dir() && info.uid() == 0 && info.mode() & 0o022 == 0,
            "TASK_PERF_CAPSULE_DIRECTORY",
        )?;
        absent(pid)
    }
    pub(super) fn current(&self, pid: u32) -> Result<()> {
        absent(pid)?;
        let named = std::fs::symlink_metadata(format!("/proc/{pid}/root/opt/reverie/perf"))?;
        let held = self.directory.as_ref().expect("opened prefix").metadata()?;
        need(
            named.is_dir() && named.dev() == held.dev() && named.ino() == held.ino(),
            "TASK_PERF_CAPSULE_ROOT_CHANGED",
        )
    }
    pub(super) fn observe(
        &self,
        runtime: &WorkerRuntime,
        inventory: &PerfCapsuleInventory,
        end: Instant,
    ) -> Result<()> {
        let fd = self.directory.as_ref().expect("opened capsule").as_raw_fd();
        for (relative, digest) in inventory.code_files() {
            check(runtime, end)?;
            let (parent, leaf) = relative.split_once('/').expect("validated code path");
            let directory =
                native::open_at(fd, OsStr::new(parent), libc::O_RDONLY | libc::O_DIRECTORY)?;
            let result = observe_file(
                runtime,
                &directory,
                leaf,
                digest.as_str(),
                parent == "bin",
                end,
            );
            finalized(result, native::close(directory).map_err(Into::into))?;
        }
        check(runtime, end)
    }
    pub(super) fn close(&mut self) -> Result<()> {
        self.directory
            .take()
            .map(native::close)
            .transpose()
            .map(|_| ())
            .map_err(Into::into)
    }
    pub(super) fn init_executable(
        &self,
        runtime: &WorkerRuntime,
        pid: u32,
        digest: &str,
        end: Instant,
    ) -> Result<()> {
        super::init::verify(
            self.directory.as_ref().expect("opened sealed prefix"),
            runtime,
            pid,
            digest,
            end,
        )
    }
}
fn absent(pid: u32) -> Result<()> {
    let path = format!(
        "/proc/{pid}/root{}",
        reverie_contracts::task_perf_capsule::ABSENT_PREFIX
    );
    match std::fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
        Ok(_) => Err(CapsuleError::Refused("TASK_PERF_LOADER_FALLBACK_PRESENT")),
    }
}
impl Drop for Root {
    fn drop(&mut self) {
        // A panic/abandoned reader cannot manufacture checked finalization.
        std::mem::forget(self.directory.take());
    }
}
fn observe_file(
    runtime: &WorkerRuntime,
    directory: &File,
    leaf: &str,
    digest: &str,
    executable: bool,
    end: Instant,
) -> Result<()> {
    check(runtime, end)?;
    let info = directory.metadata()?;
    need(
        info.uid() == 0 && info.mode() & 0o022 == 0,
        "TASK_PERF_CAPSULE_DIRECTORY",
    )?;
    // Parent is the actual held no-follow directory, not a reconstructed guest
    // path. observe_snapshot also refuses a symlink final component and stamps
    // the same opened/named regular file through checked close.
    let path = PathBuf::from(format!("/proc/self/fd/{}/{}", directory.as_raw_fd(), leaf));
    let bytes = native::observe(&path, MAX_CODE_BYTES, |info| {
        info.uid() == 0 && info.mode() & 0o022 == 0 && (!executable || info.mode() & 0o111 != 0)
    })?;
    need(
        format!("{:x}", Sha256::digest(&bytes)) == digest,
        "TASK_PERF_CAPSULE_CODE_CHANGED",
    )?;
    check(runtime, end)
}
