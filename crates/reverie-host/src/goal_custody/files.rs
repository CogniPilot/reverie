//! Original no-follow private walk; one batch retains all actual descriptors
//! and rechecks path identities before consuming each descriptor exactly once.
use super::*;
use std::{
    fs::{self, File, Metadata},
    io::Read,
    os::{fd::AsRawFd, unix::fs::MetadataExt},
    path::{Component, PathBuf},
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct Fingerprint(pub(super) [String; 5]);
impl Fingerprint {
    fn of(info: &Metadata) -> Self {
        Self([
            info.dev().to_string(),
            info.ino().to_string(),
            info.len().to_string(),
            (i128::from(info.mtime()) * 1_000_000_000 + i128::from(info.mtime_nsec())).to_string(),
            (i128::from(info.ctime()) * 1_000_000_000 + i128::from(info.ctime_nsec())).to_string(),
        ])
    }
}
struct Entry {
    path: PathBuf,
    identity: (u64, u64, u32, u32),
}
fn identity(info: &Metadata) -> (u64, u64, u32, u32) {
    (info.dev(), info.ino(), info.uid(), info.mode())
}
pub(super) struct PrivateBatch {
    files: Vec<File>,
    directories: BTreeMap<PathBuf, usize>,
    entries: Vec<Entry>,
    absent: Vec<PathBuf>,
    close_attempted: bool,
    close_uncertain: bool,
}
impl PrivateBatch {
    pub(super) fn new() -> Result<Self> {
        let root = native::open_at(
            libc::AT_FDCWD,
            std::ffi::OsStr::new("/"),
            libc::O_RDONLY | libc::O_DIRECTORY,
        )?;
        Ok(Self {
            files: vec![root],
            directories: BTreeMap::new(),
            entries: Vec::new(),
            absent: Vec::new(),
            close_attempted: false,
            close_uncertain: false,
        })
    }
    pub(super) fn read_json_file(&mut self, path: &Path) -> Result<(Fingerprint, Vec<u8>)> {
        let (fingerprint, bytes) = self.observe(path, false, false, Some(65536))?;
        Ok((
            fingerprint.expect("required file"),
            bytes.expect("bounded read"),
        ))
    }
    pub(super) fn inspect(
        &mut self,
        path: &Path,
        directory: bool,
        absent: bool,
    ) -> Result<Option<[String; 5]>> {
        Ok(self
            .observe(path, directory, absent, None)?
            .0
            .map(|value| value.0))
    }
    fn retain(&mut self, file: File) -> usize {
        let index = self.files.len();
        self.files.push(file);
        index
    }
    pub(super) fn namespace_inode(&mut self, path: &Path) -> Result<u64> {
        let file = File::open(path)?;
        let index = self.retain(file);
        Ok(self.files[index].metadata()?.ino())
    }
    fn parent(&mut self, path: &Path) -> Result<usize> {
        need(
            !self.close_attempted && path.is_absolute(),
            "Private Goal configuration unavailable",
        )?;
        let parent = path
            .parent()
            .ok_or(GoalCustodyError::Refused("Private Goal parent unavailable"))?;
        let mut current = PathBuf::from("/");
        let mut index = 0;
        for component in parent.components().skip(1) {
            need(
                matches!(component, Component::Normal(_)),
                "Private Goal configuration unavailable",
            )?;
            current.push(component.as_os_str());
            if let Some(cached) = self.directories.get(&current) {
                index = *cached;
                continue;
            }
            let file = native::open_at(
                self.files[index].as_raw_fd(),
                component.as_os_str(),
                libc::O_RDONLY | libc::O_DIRECTORY,
            )?;
            index = self.retain(file);
            let info = self.files[index].metadata()?;
            let sticky_root = info.uid() == 0 && info.mode() & libc::S_ISVTX != 0;
            need(
                (info.uid() == 0 || info.uid() == native::uid())
                    && (info.mode() & 0o022 == 0 || sticky_root),
                "Private Goal ancestry unavailable",
            )?;
            self.entries.push(Entry {
                path: current.clone(),
                identity: identity(&info),
            });
            self.directories.insert(current.clone(), index);
        }
        let parent = self.files[index].metadata()?;
        need(
            parent.uid() == native::uid() && parent.mode() & 0o077 == 0,
            "Private Goal parent unavailable",
        )?;
        Ok(index)
    }
    fn observe(
        &mut self,
        path: &Path,
        directory: bool,
        absent: bool,
        limit: Option<usize>,
    ) -> Result<(Option<Fingerprint>, Option<Vec<u8>>)> {
        let parent = self.parent(path)?;
        let leaf = path
            .file_name()
            .ok_or(GoalCustodyError::Refused("Private Goal entry unavailable"))?;
        let flags =
            libc::O_RDONLY | libc::O_NONBLOCK | if directory { libc::O_DIRECTORY } else { 0 };
        let file = match native::open_at(self.files[parent].as_raw_fd(), leaf, flags) {
            Ok(file) => file,
            Err(error) if absent && error.kind() == io::ErrorKind::NotFound => {
                self.absent.push(path.to_owned());
                self.check_absent(path)?;
                return Ok((None, None));
            }
            Err(error) => return Err(error.into()),
        };
        let index = self.retain(file);
        let info = self.files[index].metadata()?;
        need(
            (if directory {
                info.is_dir()
            } else {
                info.is_file()
            }) && info.uid() == native::uid()
                && info.mode() & 0o077 == 0
                && (directory || info.nlink() == 1),
            "Private Goal entry unavailable",
        )?;
        self.entries.push(Entry {
            path: path.to_owned(),
            identity: identity(&info),
        });
        let stamp = Fingerprint::of(&info);
        let bytes = if let Some(limit) = limit {
            need(
                !directory && info.len() <= limit as u64,
                "Private Goal entry exceeds bound",
            )?;
            let mut bytes = Vec::new();
            (&mut self.files[index])
                .take(limit as u64 + 1)
                .read_to_end(&mut bytes)?;
            need(
                bytes.len() <= limit && Fingerprint::of(&self.files[index].metadata()?) == stamp,
                "Private Goal entry changed during read",
            )?;
            Some(bytes)
        } else {
            None
        };
        Ok((Some(stamp), bytes))
    }
    fn check_absent(&self, path: &Path) -> Result<()> {
        match fs::symlink_metadata(path) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            _ => Err(GoalCustodyError::Refused(
                "Private Goal entry appeared during check",
            )),
        }
    }
    pub(super) fn check(&self) -> Result<()> {
        for entry in &self.entries {
            let info = fs::symlink_metadata(&entry.path)?;
            need(
                !info.file_type().is_symlink() && identity(&info) == entry.identity,
                "Private Goal ancestry changed",
            )?;
        }
        for path in &self.absent {
            self.check_absent(path)?;
        }
        Ok(())
    }
    pub(super) fn close(&mut self) -> Result<()> {
        if !self.close_attempted {
            self.close_attempted = true;
            for file in self.files.drain(..).rev() {
                if native::close(file).is_err() {
                    self.close_uncertain = true;
                }
            }
        }
        if self.close_uncertain {
            Err(GoalCustodyError::Cleanup)
        } else {
            Ok(())
        }
    }
}
impl Drop for PrivateBatch {
    fn drop(&mut self) {
        if !self.close_attempted {
            std::mem::forget(std::mem::take(&mut self.files));
        }
    }
}
