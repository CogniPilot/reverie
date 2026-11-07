use super::{Result, combine, require, retain_file};
use crate::native;
use std::{
    fs::{self, File, OpenOptions},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
};

struct Parent {
    file: File,
    path: PathBuf,
    identity: (u64, u64, u32, u32, u32),
}
pub(super) struct Ancestors(Vec<Parent>);
impl Ancestors {
    pub(super) fn capture(path: &Path) -> Result<Self> {
        let mut parents = Self(Vec::new());
        let result = (|| {
            for path in path.ancestors().skip(1) {
                let file = OpenOptions::new()
                    .read(true)
                    .custom_flags(
                        libc::O_PATH | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                    )
                    .open(path)?;
                let (file, info) = retain_file(file, |file| Ok(file.metadata()?))?;
                parents.0.push(Parent {
                    file,
                    path: path.to_path_buf(),
                    identity: identity(&info),
                });
            }
            parents.verify()
        })();
        match result {
            Ok(()) => Ok(parents),
            Err(error) => combine(Err(error), parents.close()),
        }
    }
    pub(super) fn verify(&self) -> Result<()> {
        for parent in &self.0 {
            require(
                identity(&parent.file.metadata()?) == parent.identity
                    && identity(&fs::symlink_metadata(&parent.path)?) == parent.identity,
                "SNAPSHOT_ANCESTOR_CHANGED",
            )?;
        }
        Ok(())
    }
    pub(super) fn close(self) -> Result<()> {
        let mut result = Ok(());
        // Close every actual pin even after an earlier finalizer refuses.
        for parent in self.0 {
            result = combine(result, native::close(parent.file).map_err(Into::into));
        }
        result
    }
}
fn identity(info: &fs::Metadata) -> (u64, u64, u32, u32, u32) {
    (info.dev(), info.ino(), info.uid(), info.gid(), info.mode())
}
