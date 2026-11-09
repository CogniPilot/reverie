use super::*;
use std::{
    ffi::OsStr,
    fs,
    os::{fd::AsRawFd, unix::fs::MetadataExt},
    path::PathBuf,
};
const NAMES: [&str; 3] = ["", "worker-pool", "policies"];
const MODES: [u32; 3] = [0o700, 0o700, 0o750];

pub(super) struct Directories {
    root: PathBuf,
    ids: [u32; 2],
    files: [Option<File>; 3],
    identity: [[u64; 2]; 3],
    creation_attempted: [bool; 3],
    close_unknown: bool,
}
impl Directories {
    pub(super) fn unopened(root: PathBuf, ids: [u32; 2]) -> Self {
        Self {
            root,
            ids,
            files: [None, None, None],
            identity: [[0; 2]; 3],
            creation_attempted: [false; 3],
            close_unknown: false,
        }
    }
    pub(super) fn open_root(&mut self) -> Result<()> {
        need(
            self.files[0].is_none() && fs::canonicalize(&self.root)? == self.root,
            "WORKER_POOL_PUBLICATION_ROOT",
        )?;
        self.files[0] = Some(native::open_at(
            libc::AT_FDCWD,
            self.root.as_os_str(),
            libc::O_RDONLY | libc::O_DIRECTORY,
        )?);
        self.capture(0)
    }
    pub(super) fn open_child(&mut self, index: usize) -> Result<()> {
        need(
            (1..=2).contains(&index)
                && self.files[index].is_none()
                && !self.creation_attempted[index],
            "WORKER_POOL_PUBLICATION_DIRECTORY_REPLAYED",
        )?;
        self.current(index - 1)?;
        self.creation_attempted[index] = true;
        let created = match nix::sys::stat::mkdirat(
            self.file(index - 1)?,
            NAMES[index],
            nix::sys::stat::Mode::S_IRWXU,
        ) {
            Ok(()) => true,
            Err(nix::errno::Errno::EEXIST) => false,
            Err(error) => return Err(io::Error::from(error).into()),
        };
        self.files[index] = Some(native::open_at(
            self.file(index - 1)?.as_raw_fd(),
            OsStr::new(NAMES[index]),
            libc::O_RDONLY | libc::O_DIRECTORY,
        )?);
        if created {
            // Only a new, opened, same-named owned directory may change mode.
            // Existing mode/ownership failures are never silently repaired.
            self.require_mode(index, 0o700)?;
            nix::sys::stat::fchmod(
                self.file(index)?,
                nix::sys::stat::Mode::from_bits_truncate(MODES[index]),
            )
            .map_err(io::Error::from)?;
        }
        self.capture(index)?;
        self.current(index - 1)
    }
    fn file(&self, index: usize) -> Result<&File> {
        self.files[index].as_ref().ok_or(PoolError::Refused(
            "WORKER_POOL_PUBLICATION_DIRECTORY_CLOSED",
        ))
    }
    fn named(&self, index: usize) -> Result<fs::Metadata> {
        if index == 0 {
            Ok(fs::symlink_metadata(&self.root)?)
        } else {
            Ok(fs::symlink_metadata(format!(
                "/proc/self/fd/{}/{}",
                self.file(index - 1)?.as_raw_fd(),
                NAMES[index]
            ))?)
        }
    }
    fn require_mode(&self, index: usize, mode: u32) -> Result<()> {
        let held = self.file(index)?.metadata()?;
        let named = self.named(index)?;
        need(
            [&held, &named]
                .iter()
                .all(|m| m.is_dir() && [m.uid(), m.gid()] == self.ids && m.mode() & 0o7777 == mode)
                && [held.dev(), held.ino()] == [named.dev(), named.ino()],
            "WORKER_POOL_PUBLICATION_DIRECTORY_CUSTODY",
        )
    }
    fn capture(&mut self, index: usize) -> Result<()> {
        self.require_mode(index, MODES[index])?;
        let info = self.file(index)?.metadata()?;
        self.identity[index] = [info.dev(), info.ino()];
        self.current(index)
    }
    fn current(&self, index: usize) -> Result<()> {
        need(!self.close_unknown, "WORKER_POOL_PUBLICATION_CLOSE_UNKNOWN")?;
        self.require_mode(index, MODES[index])?;
        let info = self.file(index)?.metadata()?;
        need(
            [info.dev(), info.ino()] == self.identity[index],
            "WORKER_POOL_PUBLICATION_DIRECTORY_REBOUND",
        )
    }
    pub(super) fn versions(&self) -> Result<&File> {
        for index in 0..=2 {
            self.current(index)?;
        }
        self.file(2)
    }
    pub(super) fn version_identity(&self) -> Result<[u64; 2]> {
        self.versions()?;
        Ok(self.identity[2])
    }
    #[cfg(test)]
    pub(super) fn retained_stamps(&self) -> Vec<(i32, u64, u64)> {
        self.files
            .iter()
            .flatten()
            .map(|file| {
                let info = file.metadata().unwrap();
                (file.as_raw_fd(), info.dev(), info.ino())
            })
            .collect()
    }
    pub(super) fn sync(&self) -> Result<()> {
        // Sync every actual parent, including newly created directory entries.
        let mut result = Ok(());
        for index in (0..=2).rev() {
            let synced = self
                .current(index)
                .and_then(|()| self.file(index)?.sync_all().map_err(Into::into));
            result = finalized(result, synced);
        }
        result
    }
    pub(super) fn close(&mut self) -> Result<()> {
        let mut result = Ok(());
        for file in self.files.iter_mut().rev() {
            let closed = file
                .take()
                .map(native::close)
                .transpose()
                .map(|_| ())
                .map_err(Into::into);
            result = finalized(result, closed);
        }
        self.close_unknown |= result.is_err();
        result?;
        need(!self.close_unknown, "WORKER_POOL_PUBLICATION_CLOSE_UNKNOWN")
    }
}
impl Drop for Directories {
    fn drop(&mut self) {
        for file in &mut self.files {
            std::mem::forget(file.take());
        }
    }
}
