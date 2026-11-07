//! The cold protocol owns its readable directory descriptors and rechecks the
//! original Python path spelling as well as held/named identity/type/UID/mode.
use super::*;
use std::{ffi::OsStr, io::Write};
pub(super) struct Directory {
    pub(super) file: File,
    pub(super) text: PosixPath,
    pub(super) path: PathBuf,
    stamp: Stamp,
}
impl Directory {
    pub(super) fn open(text: PosixPath, uid: u32) -> Result<Self> {
        let path = native::python_path(&text.codepoints())?;
        need(
            native::resolve_strict_text(&text.codepoints())? == text,
            StorageFault::CanonicalPath,
        )?;
        let file = native::open_at(
            libc::AT_FDCWD,
            path.as_os_str(),
            libc::O_RDONLY | libc::O_DIRECTORY,
        )?;
        let result = (|| {
            let stamp = Stamp::capture(&file.metadata()?);
            need(
                stamp.directory() && stamp.uid == uid && stamp.mode & 0o077 == 0,
                StorageFault::PrivateDirectory,
            )?;
            Ok(stamp)
        })();
        let stamp = match result {
            Ok(stamp) => stamp,
            Err(error) => return finalized(Err(error), fs::close(file)),
        };
        let directory = Self {
            file,
            text,
            path,
            stamp,
        };
        match directory.check() {
            Ok(()) => Ok(directory),
            Err(error) => finalized(Err(error), directory.close()),
        }
    }
    pub(super) fn check(&self) -> Result<()> {
        let held = Stamp::capture(&self.file.metadata()?);
        let named = Stamp::capture(&std::fs::symlink_metadata(&self.path)?);
        need(
            self.stamp.same_directory(&held)
                && held.same_directory(&named)
                && native::resolve_strict_text(&self.text.codepoints())? == self.text,
            StorageFault::DirectoryChanged,
        )
    }
    pub(super) fn close(self) -> Result<()> {
        fs::close(self.file)
    }
    pub(super) fn publish(&self, name: &OsStr, raw: &[u8]) -> Result<Stamp> {
        self.check()?;
        let mut output = native::open_at_mode(
            self.file.as_raw_fd(),
            name,
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NONBLOCK,
            0o600,
        )?;
        let result = (|| {
            output.write_all(raw)?;
            output.sync_all()?;
            Ok(Stamp::capture(&output.metadata()?))
        })();
        let stamp = finalized(result, fs::close(output))?;
        self.file.sync_all()?;
        self.check()?;
        self.named(name, &stamp)?;
        Ok(stamp)
    }
    pub(super) fn named(&self, name: &OsStr, expected: &Stamp) -> Result<()> {
        self.check()?;
        need(
            Stamp::capture(&std::fs::symlink_metadata(self.path.join(name))?) == *expected,
            StorageFault::ColdTree,
        )
    }
}
