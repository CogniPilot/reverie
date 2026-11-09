use super::error::{Result, finalized, need};
use crate::native;
use std::{
    fs::{self, File},
    os::{
        fd::AsRawFd,
        unix::fs::{DirBuilderExt, MetadataExt},
    },
    path::PathBuf,
};
const NAMES: [&str; 2] = ["stat.csv", "perf.data"];

#[derive(PartialEq)]
struct Stamp {
    key: [u64; 2],
    len: u64,
    times: [i64; 4],
}
impl Stamp {
    fn of(info: &fs::Metadata) -> Self {
        Self {
            key: [info.dev(), info.ino()],
            len: info.len(),
            times: [
                info.mtime(),
                info.mtime_nsec(),
                info.ctime(),
                info.ctime_nsec(),
            ],
        }
    }
}
pub(super) struct Workspace {
    path: PathBuf,
    directory: Option<File>,
    key: Option<[u64; 2]>,
    files: [Option<Stamp>; 2],
    created: bool,
    closed: bool,
    close_unknown: bool,
}
impl Workspace {
    pub(super) fn unopened() -> Result<Self> {
        let mut random = [0; 16];
        getrandom::getrandom(&mut random)
            .map_err(|_| super::PerfCheckError::Refused("TASK_PERF_RANDOM_UNAVAILABLE"))?;
        Ok(Self {
            path: PathBuf::from(format!(
                "/tmp/.reverie-perf-{}-{:032x}",
                std::process::id(),
                u128::from_ne_bytes(random)
            )),
            directory: None,
            key: None,
            files: [None, None],
            created: false,
            closed: false,
            close_unknown: false,
        })
    }
    pub(super) fn create(&mut self) -> Result<()> {
        fs::DirBuilder::new().mode(0o700).create(&self.path)?;
        self.created = true;
        self.directory = Some(native::open_at(
            libc::AT_FDCWD,
            self.path.as_os_str(),
            libc::O_RDONLY | libc::O_DIRECTORY,
        )?);
        let info = self
            .directory
            .as_ref()
            .expect("retained opened directory")
            .metadata()?;
        need(
            info.is_dir() && info.uid() == native::uid() && info.mode() & 0o7777 == 0o700,
            "TASK_PERF_WORKSPACE_CUSTODY",
        )?;
        self.key = Some([info.dev(), info.ino()]);
        self.current()
    }
    fn current(&self) -> Result<()> {
        let directory = self
            .directory
            .as_ref()
            .ok_or(super::PerfCheckError::Refused(
                "TASK_PERF_WORKSPACE_UNOPENED",
            ))?;
        let opened = directory.metadata()?;
        let named = fs::symlink_metadata(&self.path)?;
        need(
            [opened, named].iter().all(|m| {
                m.is_dir()
                    && m.uid() == native::uid()
                    && m.mode() & 0o7777 == 0o700
                    && self.key == Some([m.dev(), m.ino()])
            }),
            "TASK_PERF_WORKSPACE_CHANGED",
        )
    }
    pub(super) fn directory(&self) -> Result<PathBuf> {
        self.current()?;
        Ok(PathBuf::from(format!(
            "/proc/self/fd/{}",
            self.directory
                .as_ref()
                .expect("actual directory")
                .as_raw_fd()
        )))
    }
    fn file(&self, at: usize) -> Result<PathBuf> {
        Ok(self.directory()?.join(NAMES[at]))
    }
    pub(super) fn stat(&mut self) -> Result<Vec<u8>> {
        let observed = native::observe_snapshot(&self.file(0)?, 65_536, owned_file)?;
        self.files[0] = Some(Stamp::of(&observed.metadata));
        Ok(observed.bytes)
    }
    pub(super) fn recording(&mut self) -> Result<()> {
        let info = fs::symlink_metadata(self.file(1)?)?;
        need(
            owned_file(&info) && (1..=16 * 1024 * 1024).contains(&info.len()),
            "TASK_PERF_RECORDING_CUSTODY",
        )?;
        self.files[1] = Some(Stamp::of(&info));
        Ok(())
    }
    /// Called only after actual captured producers settle. Unknown outputs are
    /// never swept; a failed/uncertain cleanup is one-shot and stays negative.
    pub(super) fn close(&mut self, remove: bool) -> Result<()> {
        if self.closed {
            return need(!self.close_unknown, "TASK_PERF_WORKSPACE_CLOSE_UNKNOWN");
        }
        self.closed = true;
        let body = if remove && self.created {
            self.remove()
        } else {
            Ok(())
        };
        let closed = self
            .directory
            .take()
            .map(native::close)
            .transpose()
            .map(|_| ())
            .map_err(Into::into);
        let result = finalized(body, closed);
        self.close_unknown |= result.is_err();
        result
    }
    fn remove(&self) -> Result<()> {
        self.current()?;
        for (at, expected) in self.files.iter().enumerate() {
            if let Some(expected) = expected {
                let path = self.file(at)?;
                let info = fs::symlink_metadata(&path)?;
                need(
                    owned_file(&info) && Stamp::of(&info) == *expected,
                    "TASK_PERF_OUTPUT_CHANGED",
                )?;
                fs::remove_file(path)?;
            }
        }
        self.current()?;
        // Unexpected files leave the original directory and evidence intact.
        fs::remove_dir(&self.path)?;
        Ok(())
    }
}
fn owned_file(info: &fs::Metadata) -> bool {
    info.is_file()
        && info.uid() == native::uid()
        && info.nlink() == 1
        && info.mode() & 0o7777 == 0o600
}
impl Drop for Workspace {
    fn drop(&mut self) {
        if !self.closed {
            std::mem::forget(self.directory.take());
        }
    }
}
