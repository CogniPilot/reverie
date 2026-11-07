//! Anchored cgroupfs operations. All names/values are fixed by the closed pool
//! purpose. Uses the existing checked-open/close syscall owner; no new unsafe.
use super::*;
use crate::native;
use std::{
    ffi::OsStr,
    fs::File,
    io::Read,
    os::{fd::AsRawFd, unix::fs::MetadataExt},
    path::Path,
};

pub(super) struct PoolDirectory {
    root: Option<File>,
    parent: Option<File>,
    anchor: Option<File>,
    name: String,
    identity: (u64, u64),
    anchor_identity: (u64, u64),
    anchor_start: String,
    close_unknown: bool,
}
impl PoolDirectory {
    pub(super) fn unopened(policy: &WorkerPoolPolicy) -> Self {
        Self {
            root: None,
            parent: None,
            anchor: None,
            name: policy.parent_slice(),
            identity: (0, 0),
            anchor_identity: (0, 0),
            anchor_start: String::new(),
            close_unknown: false,
        }
    }
    pub(super) fn acquire(&mut self, anchor: &str, pid: u32) -> Result<()> {
        self.root = Some(native::open_at(
            nix::libc::AT_FDCWD,
            OsStr::new("/sys/fs/cgroup"),
            nix::libc::O_RDONLY | nix::libc::O_DIRECTORY,
        )?);
        let root = self
            .root
            .as_ref()
            .ok_or(PoolError::Refused("WORKER_POOL_DIRECTORY_CLOSED"))?;
        let filesystem = nix::sys::statfs::fstatfs(root)
            .map_err(|_| PoolError::Refused("WORKER_POOL_FILESYSTEM_UNKNOWN"))?;
        need(
            filesystem.filesystem_type() == nix::sys::statfs::CGROUP2_SUPER_MAGIC,
            "WORKER_POOL_CGROUP2_REQUIRED",
        )?;
        self.parent = Some(native::open_at(
            root.as_raw_fd(),
            OsStr::new(&self.name),
            nix::libc::O_RDONLY | nix::libc::O_DIRECTORY,
        )?);
        self.identity = identity(self.parent()?)?;
        self.anchor = Some(native::open_at(
            self.parent()?.as_raw_fd(),
            OsStr::new(&format!("docker-{anchor}.scope")),
            nix::libc::O_RDONLY | nix::libc::O_DIRECTORY,
        )?);
        self.anchor_identity = identity(
            self.anchor
                .as_ref()
                .ok_or(PoolError::Refused("WORKER_POOL_DIRECTORY_CLOSED"))?,
        )?;
        self.anchor_start = process_start(pid)?;
        self.assert_anchor_only(anchor, pid)
    }
    fn parent(&self) -> Result<&File> {
        self.parent
            .as_ref()
            .ok_or(PoolError::Refused("WORKER_POOL_DIRECTORY_CLOSED"))
    }
    fn assert_current(&self) -> Result<()> {
        let root = self
            .root
            .as_ref()
            .ok_or(PoolError::Refused("WORKER_POOL_DIRECTORY_CLOSED"))?;
        let named = native::open_at(
            root.as_raw_fd(),
            OsStr::new(&self.name),
            nix::libc::O_RDONLY | nix::libc::O_DIRECTORY,
        )?;
        let result = (|| {
            need(
                identity(&named)? == self.identity && identity(self.parent()?)? == self.identity,
                "WORKER_POOL_DIRECTORY_REBOUND",
            )
        })();
        finalized(result, native::close(named).map_err(Into::into))
    }
    pub(super) fn assert_anchor_current(&self, anchor: &str, pid: u32) -> Result<()> {
        self.assert_current()?;
        let scope = format!("docker-{anchor}.scope");
        let expected = format!("0::/{}/{scope}\n", self.name);
        let raw = bounded_path(&format!("/proc/{pid}/cgroup"), 4096)?;
        need(raw == expected, "WORKER_POOL_ANCHOR_MEMBERSHIP")?;
        need(
            read_at(self.parent()?, "cgroup.procs")?.trim().is_empty(),
            "WORKER_POOL_INTERNAL_PROCESSES",
        )?;
        let child = native::open_at(
            self.parent()?.as_raw_fd(),
            OsStr::new(&scope),
            nix::libc::O_RDONLY | nix::libc::O_DIRECTORY,
        )?;
        let result = (|| {
            let original = self
                .anchor
                .as_ref()
                .ok_or(PoolError::Refused("WORKER_POOL_DIRECTORY_CLOSED"))?;
            need(
                identity(&child)? == self.anchor_identity
                    && identity(original)? == self.anchor_identity,
                "WORKER_POOL_ANCHOR_REBOUND",
            )?;
            need(
                process_start(pid)? == self.anchor_start,
                "WORKER_POOL_ANCHOR_PID_CHANGED",
            )?;
            let members = read_at(&child, "cgroup.procs")?;
            need(
                members == format!("{pid}\n"),
                "WORKER_POOL_ANCHOR_PROCESSES",
            )?;
            self.assert_current()
        })();
        finalized(result, native::close(child).map_err(Into::into))
    }
    pub(super) fn assert_anchor_only(&self, anchor: &str, pid: u32) -> Result<()> {
        self.assert_anchor_current(anchor, pid)?;
        let scope = format!("docker-{anchor}.scope");
        // This enumerates the retained directory, not a reconstructed path.
        let directory = format!("/proc/self/fd/{}", self.parent()?.as_raw_fd());
        for entry in std::fs::read_dir(directory)? {
            let entry = entry?;
            need(
                !entry.file_type()?.is_dir() || entry.file_name() == OsStr::new(&scope),
                "WORKER_POOL_UNEXPECTED_CHILD",
            )?;
        }
        self.assert_current()
    }
    pub(super) fn configure(&self, policy: &WorkerPoolPolicy) -> Result<()> {
        let max = (u64::from(policy.memory_max_mi_b) * 1_048_576).to_string();
        for (name, value) in [
            ("memory.max", max),
            ("memory.swap.max", "0".into()),
            ("memory.high", "max".into()),
            ("cpu.max", "max 100000".into()),
            ("cpu.weight", policy.cpu_weight.to_string()),
            ("cpuset.cpus", policy.cpu_list()),
        ] {
            self.assert_current()?;
            write_at(self.parent()?, name, value.as_bytes())?;
        }
        Ok(())
    }
    pub(super) fn assert_limits(&self, policy: &WorkerPoolPolicy) -> Result<()> {
        self.assert_current()?;
        let max = (u64::from(policy.memory_max_mi_b) * 1_048_576).to_string();
        for (name, expected) in [
            ("memory.max", max),
            ("memory.swap.max", "0".into()),
            ("memory.high", "max".into()),
            ("cpu.max", "max 100000".into()),
            ("cpu.weight", policy.cpu_weight.to_string()),
        ] {
            need(
                read_at(self.parent()?, name)?.trim() == expected,
                "WORKER_POOL_LIMIT_READBACK",
            )?;
        }
        // Kernel canonicalizes CPU lists into ranges; compare physical sets.
        let actual = parse_cpus(read_at(self.parent()?, "cpuset.cpus.effective")?.trim())?;
        need(actual == policy.allowed_cpus, "WORKER_POOL_CPU_PLACEMENT")?;
        self.assert_current()
    }
    pub(super) fn identity(&self) -> (u64, u64) {
        self.identity
    }
    pub(super) fn close(&mut self) -> Result<()> {
        let anchor = self
            .anchor
            .take()
            .map(native::close)
            .transpose()
            .map(|_| ())
            .map_err(Into::into);
        let parent = self
            .parent
            .take()
            .map(native::close)
            .transpose()
            .map(|_| ())
            .map_err(Into::into);
        let root = self
            .root
            .take()
            .map(native::close)
            .transpose()
            .map(|_| ())
            .map_err(Into::into);
        let result = finalized(finalized(anchor, parent), root);
        self.close_unknown |= result.is_err();
        result?;
        need(!self.close_unknown, "WORKER_POOL_CLOSE_UNKNOWN")
    }
}
fn identity(file: &File) -> Result<(u64, u64)> {
    let metadata = file.metadata()?;
    need(
        metadata.is_dir() && metadata.uid() == 0,
        "WORKER_POOL_DIRECTORY_OWNER",
    )?;
    Ok((metadata.dev(), metadata.ino()))
}
fn read_at(parent: &File, name: &str) -> Result<String> {
    let file = native::open_at(
        parent.as_raw_fd(),
        OsStr::new(name),
        nix::libc::O_RDONLY | nix::libc::O_NONBLOCK,
    )?;
    let result = read(&file, 65_536);
    finalized(result, native::close(file).map_err(Into::into))
}
fn read(file: &File, max: usize) -> Result<String> {
    let mut raw = Vec::new();
    file.take((max + 1) as u64).read_to_end(&mut raw)?;
    need(raw.len() <= max, "WORKER_POOL_READ_BOUND")?;
    String::from_utf8(raw).map_err(|_| PoolError::Refused("WORKER_POOL_READ_ENCODING"))
}
fn bounded_path(path: &str, max: usize) -> Result<String> {
    let file = native::open_at(
        nix::libc::AT_FDCWD,
        Path::new(path).as_os_str(),
        nix::libc::O_RDONLY | nix::libc::O_NONBLOCK,
    )?;
    let result = read(&file, max);
    finalized(result, native::close(file).map_err(Into::into))
}
fn process_start(pid: u32) -> Result<String> {
    let stat = bounded_path(&format!("/proc/{pid}/stat"), 65_536)?;
    reverie_contracts::kernel_accounting::process_start(&stat)
        .map_err(|_| PoolError::Refused("WORKER_POOL_ANCHOR_PID_UNKNOWN"))
}
fn write_at(parent: &File, name: &str, value: &[u8]) -> Result<()> {
    let file = native::open_at(
        parent.as_raw_fd(),
        OsStr::new(name),
        nix::libc::O_WRONLY | nix::libc::O_NONBLOCK,
    )?;
    let result = nix::unistd::write(&file, value)
        .map_err(|_| PoolError::Refused("WORKER_POOL_WRITE_UNKNOWN"))
        .and_then(|count| need(count == value.len(), "WORKER_POOL_WRITE_PARTIAL"));
    finalized(result, native::close(file).map_err(Into::into))
}
fn parse_cpus(raw: &str) -> Result<Vec<u32>> {
    let mut cpus = Vec::new();
    for part in raw.split(',') {
        let (start, end) = part.split_once('-').unwrap_or((part, part));
        let start: u32 = start
            .parse()
            .map_err(|_| PoolError::Refused("WORKER_POOL_CPU_ENCODING"))?;
        let end: u32 = end
            .parse()
            .map_err(|_| PoolError::Refused("WORKER_POOL_CPU_ENCODING"))?;
        need(start <= end && end < 4096, "WORKER_POOL_CPU_BOUND")?;
        cpus.extend(start..=end);
        need(cpus.len() <= 4096, "WORKER_POOL_CPU_BOUND")?;
    }
    need(
        cpus.windows(2).all(|pair| pair[0] < pair[1]),
        "WORKER_POOL_CPU_ENCODING",
    )?;
    Ok(cpus)
}
