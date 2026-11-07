//! Private fixed-root PID/cgroup custody. No request-selected path or writer API.
use super::*;
use crate::native;
use std::{
    ffi::OsStr,
    fs::File,
    io::Read,
    os::{fd::AsRawFd, unix::fs::MetadataExt},
    path::{Component, Path, PathBuf},
};

pub(in crate::worker_laptop) struct Target {
    directory: File,
    pid: u32,
    proc: PathBuf,
    cgroup: PathBuf,
    relative: PathBuf,
    start: String,
    groups: String,
    leaf: (u64, u64),
}
impl Target {
    pub(super) fn process_id(&self) -> u32 {
        self.pid
    }
    pub(super) fn open(pid: u32) -> Result<Self> {
        Self::capture(pid, Path::new("/proc"), Path::new("/sys/fs/cgroup"))
    }
    pub(super) fn capture(pid: u32, proc: &Path, cgroup: &Path) -> Result<Self> {
        need(pid > 0, "LAPTOP_MEMORY_IDENTITY")?;
        let start = pid_start(proc, pid)?;
        let groups = groups(proc, pid)?;
        let lines: Vec<_> = groups.lines().collect();
        need(
            lines.len() == 1 && lines[0].starts_with("0::/"),
            "LAPTOP_MEMORY_IDENTITY",
        )?;
        let relative = PathBuf::from(&lines[0][4..]);
        need(
            !relative.as_os_str().is_empty()
                && !relative.is_absolute()
                && relative
                    .components()
                    .all(|c| matches!(c, Component::Normal(_))),
            "LAPTOP_MEMORY_IDENTITY",
        )?;
        let directory = walk(cgroup, &relative)?;
        let info = directory.metadata().map_err(LaptopError::Io);
        let info = match info {
            Ok(info) => info,
            Err(error) => {
                return finalized(
                    Err(error),
                    native::close(directory).map_err(LaptopError::Observation),
                );
            }
        };
        Ok(Self {
            directory,
            pid,
            proc: proc.to_owned(),
            cgroup: cgroup.to_owned(),
            relative,
            start,
            groups,
            leaf: (info.dev(), info.ino()),
        })
    }
    pub(super) fn fences(&self) -> Result<()> {
        let current = walk(&self.cgroup, &self.relative)?;
        let info = current.metadata().map_err(LaptopError::Io);
        let info = finalized(
            info,
            native::close(current).map_err(LaptopError::Observation),
        )?;
        need(
            pid_start(&self.proc, self.pid)? == self.start
                && groups(&self.proc, self.pid)? == self.groups
                && (info.dev(), info.ino()) == self.leaf,
            "LAPTOP_MEMORY_IDENTITY",
        )
    }
    pub(super) fn hard_is(&self, expected: &str) -> Result<()> {
        need(
            self.read("memory.max")? == expected,
            "LAPTOP_MEMORY_HARD_LIMIT",
        )
    }
    pub(super) fn high_is(&self, expected: &str) -> Result<()> {
        need(
            self.read("memory.high")? == expected,
            "LAPTOP_MEMORY_HIGH_READBACK",
        )
    }
    fn read(&self, name: &'static str) -> Result<String> {
        let mut file = native::open_at(
            self.directory.as_raw_fd(),
            OsStr::new(name),
            libc::O_RDONLY | libc::O_NONBLOCK,
        )
        .map_err(LaptopError::Io)?;
        let read = bounded(&mut file, 128);
        let raw = finalized(read, native::close(file).map_err(LaptopError::Observation))?;
        need(raw.is_ascii(), "LAPTOP_MEMORY_IDENTITY")?;
        Ok(String::from_utf8(raw).expect("ASCII").trim().to_owned())
    }
    /// Caller refreshed engine/local fences and memory.max first. The original
    /// deadline is checked last, immediately before the fixed writer open.
    pub(super) fn write_high(
        &self,
        high: &str,
        deadline: Instant,
        attempted: &mut bool,
    ) -> Result<()> {
        need(Instant::now() < deadline, "LAPTOP_MEMORY_DEADLINE")?;
        let writer = native::open_at(
            self.directory.as_raw_fd(),
            OsStr::new("memory.high"),
            libc::O_WRONLY | libc::O_NONBLOCK,
        )
        .map_err(|error| {
            if matches!(
                error.raw_os_error(),
                Some(libc::EACCES | libc::EPERM | libc::EROFS)
            ) {
                LaptopError::Refused("LAPTOP_SOFT_LIMIT_WRITE_AUTHORITY")
            } else {
                LaptopError::Io(error)
            }
        })?;
        *attempted = true;
        let raw = format!("{high}\n");
        // nix::unistd::write performs one write syscall; no EINTR/short-write retry.
        let written = write_once(&writer, raw.as_bytes())
            .map_err(|error| LaptopError::Io(std::io::Error::from_raw_os_error(error as i32)))
            .and_then(|count| need(count == raw.len(), "LAPTOP_MEMORY_SHORT_WRITE"));
        finalized(
            written,
            native::close(writer).map_err(LaptopError::Observation),
        )
    }
    pub(super) fn close(self) -> Result<()> {
        native::close(self.directory).map_err(LaptopError::Observation)
    }
}
fn write_once(writer: &File, raw: &[u8]) -> nix::Result<usize> {
    #[cfg(test)]
    let raw = faults::writing(raw)?;
    nix::unistd::write(writer, raw)
}

fn walk(root: &Path, relative: &Path) -> Result<File> {
    let mut directory = native::open_at(
        libc::AT_FDCWD,
        root.as_os_str(),
        libc::O_RDONLY | libc::O_DIRECTORY,
    )
    .map_err(LaptopError::Io)?;
    for part in relative.components() {
        if !matches!(part, Component::Normal(_)) {
            return finalized(
                Err(LaptopError::Refused("LAPTOP_MEMORY_IDENTITY")),
                native::close(directory).map_err(LaptopError::Observation),
            );
        }
        let child = native::open_at(
            directory.as_raw_fd(),
            part.as_os_str(),
            libc::O_RDONLY | libc::O_DIRECTORY,
        )
        .map_err(LaptopError::Io);
        let closed = native::close(directory).map_err(LaptopError::Observation);
        directory = match (child, closed) {
            (Ok(child), Ok(())) => child,
            (Err(error), closed) => return finalized(Err(error), closed),
            (Ok(child), Err(error)) => {
                return finalized(
                    Err(error),
                    native::close(child).map_err(LaptopError::Observation),
                );
            }
        };
    }
    Ok(directory)
}
fn bounded(file: &mut File, maximum: usize) -> Result<Vec<u8>> {
    let mut raw = Vec::new();
    file.take((maximum + 1) as u64)
        .read_to_end(&mut raw)
        .map_err(LaptopError::Io)?;
    need(raw.len() <= maximum, "LAPTOP_MEMORY_READ_BOUND")?;
    Ok(raw)
}
fn proc_bytes(proc: &Path, pid: u32, name: &str) -> Result<Vec<u8>> {
    let mut file = native::open_at(
        libc::AT_FDCWD,
        proc.join(pid.to_string()).join(name).as_os_str(),
        libc::O_RDONLY | libc::O_NONBLOCK,
    )
    .map_err(LaptopError::Io)?;
    let read = bounded(&mut file, 4096);
    finalized(read, native::close(file).map_err(LaptopError::Observation))
}
fn pid_start(proc: &Path, pid: u32) -> Result<String> {
    let raw = proc_bytes(proc, pid, "stat")?;
    let end = raw
        .iter()
        .rposition(|byte| *byte == b')')
        .ok_or(LaptopError::Refused("LAPTOP_MEMORY_IDENTITY"))?;
    let token = raw[end + 1..]
        .split(|byte| byte.is_ascii_whitespace())
        .filter(|token| !token.is_empty())
        .nth(19)
        .ok_or(LaptopError::Refused("LAPTOP_MEMORY_IDENTITY"))?;
    std::str::from_utf8(token)
        .map(str::to_owned)
        .map_err(|_| LaptopError::Refused("LAPTOP_MEMORY_IDENTITY"))
}
fn groups(proc: &Path, pid: u32) -> Result<String> {
    let raw = proc_bytes(proc, pid, "cgroup")?;
    need(raw.is_ascii(), "LAPTOP_MEMORY_IDENTITY")?;
    Ok(std::str::from_utf8(&raw)
        .expect("ASCII")
        .lines()
        .collect::<Vec<_>>()
        .join("\n"))
}

#[cfg(test)]
pub(super) mod faults {
    use std::cell::Cell;
    #[derive(Clone, Copy)]
    pub(in crate::worker_laptop::memory) enum WriteFault {
        Short,
        Interrupted,
    }
    thread_local! {
        static NEXT: Cell<Option<WriteFault>> = const { Cell::new(None) };
        static CALLS: Cell<usize> = const { Cell::new(0) };
    }
    pub(in crate::worker_laptop::memory) fn set(fault: Option<WriteFault>) {
        NEXT.set(fault);
        CALLS.set(0);
    }
    pub(in crate::worker_laptop::memory) fn calls() -> usize {
        CALLS.get()
    }
    pub(super) fn writing(raw: &[u8]) -> nix::Result<&[u8]> {
        CALLS.set(CALLS.get() + 1);
        match NEXT.take() {
            Some(WriteFault::Short) => Ok(&raw[..1]),
            Some(WriteFault::Interrupted) => Err(nix::errno::Errno::EINTR),
            None => Ok(raw),
        }
    }
}
