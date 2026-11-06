use super::{ChildCause, ChildCleanup, ChildError, ChildPhase, RecordDisposition, error::Result};
use crate::native;
use reverie_core::posix_path::PosixPath;
use std::{
    ffi::OsString,
    fs::{self, File},
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
};
/// Actual held parent namespace, with named-entry rechecks. This pins inode
/// identity, not a pathname lease or protection from arbitrary same-UID renames.
pub(super) struct Directory {
    root: PathBuf,
    file: Option<File>,
    identity: (u64, u64, u32, u32),
}
pub(super) fn name(path: &Path, root: &Path) -> Result<OsString> {
    let error = || ChildError::new(ChildPhase::Record, ChildCause::Scope);
    let lexical = PosixPath::try_new(&native::python_text(path)).map_err(|_| error())?;
    if lexical.parent() != PosixPath::try_new(&native::python_text(root)).map_err(|_| error())? {
        return Err(error());
    }
    native::python_path(&lexical.codepoints())
        .map_err(|cause| ChildError::new(ChildPhase::Record, ChildCause::Io(cause)))?
        .file_name()
        .map(ToOwned::to_owned)
        .ok_or_else(error)
}
impl Directory {
    pub(super) fn open(root: &Path) -> Result<Self> {
        let file = native::open_at(
            libc::AT_FDCWD,
            root.as_os_str(),
            libc::O_RDONLY | libc::O_DIRECTORY,
        )
        .map_err(io)?;
        let mut directory = Self {
            root: root.to_owned(),
            file: Some(file),
            identity: (0, 0, 0, 0),
        };
        let result = (|| {
            let info = directory.file().metadata().map_err(io)?;
            if info.uid() != native::uid() || info.mode() & 0o022 != 0 {
                return Err(error(ChildCause::Custody));
            }
            directory.identity = identity(&info);
            directory.recheck()
        })();
        if let Err(error) = result {
            return directory.finish(
                Err(error),
                RecordDisposition::Untouched,
                ChildCleanup::RecordDirectoryClose,
            );
        }
        Ok(directory)
    }
    pub(super) fn file(&self) -> &File {
        self.file.as_ref().expect("held launch parent")
    }
    pub(super) fn recheck(&self) -> Result<()> {
        let named = fs::symlink_metadata(&self.root).map_err(io)?;
        let held = self.file().metadata().map_err(io)?;
        if !named.is_dir()
            || identity(&named) != self.identity
            || identity(&held) != self.identity
            || named.mode() & 0o022 != 0
        {
            return Err(error(ChildCause::Changed));
        }
        Ok(())
    }
    pub(super) fn finish<T>(
        mut self,
        result: Result<T>,
        state: RecordDisposition,
        fault: ChildCleanup,
    ) -> Result<T> {
        finalized(
            result,
            self.file.take().expect("owned parent"),
            state,
            fault,
        )
    }
}
pub(super) fn finalized<T>(
    result: Result<T>,
    file: File,
    state: RecordDisposition,
    fault: ChildCleanup,
) -> Result<T> {
    match (result, native::close(file)) {
        (result, Ok(())) => result,
        (Ok(_), Err(_)) => Err(error(ChildCause::Finalization)
            .spent(state)
            .finalizer(fault)),
        (Err(cause), Err(_)) => Err(cause.spent(state).finalizer(fault)),
    }
}
fn identity(info: &fs::Metadata) -> (u64, u64, u32, u32) {
    (info.dev(), info.ino(), info.uid(), info.mode())
}
fn error(cause: ChildCause) -> ChildError {
    ChildError::new(ChildPhase::Record, cause)
}
fn io(cause: std::io::Error) -> ChildError {
    error(ChildCause::Io(cause))
}
