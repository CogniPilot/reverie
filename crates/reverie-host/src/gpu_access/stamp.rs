use super::*;
use std::{fs, os::unix::fs::MetadataExt, path::Path};
/// Exact `_stamp` eight-field DATA. A named signature is only an observation;
/// it is not an inode-conditional rename against a noncooperating same-UID actor.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GpuFileStamp {
    device: u64,
    inode: u64,
    mode: u32,
    uid: u32,
    links: u64,
    size: u64,
    mtime: (i64, i64),
    ctime: (i64, i64),
}
impl GpuFileStamp {
    pub fn observe(path: &Path) -> Result<Self> {
        Ok(Self::of(&fs::symlink_metadata(path)?))
    }
    pub fn observe_optional(path: &Path) -> Result<Option<Self>> {
        match fs::symlink_metadata(path) {
            Ok(info) => Ok(Some(Self::of(&info))),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.into()),
        }
    }
    pub(crate) fn of(info: &fs::Metadata) -> Self {
        Self {
            device: info.dev(),
            inode: info.ino(),
            mode: info.mode(),
            uid: info.uid(),
            links: info.nlink(),
            size: info.len(),
            mtime: (info.mtime(), info.mtime_nsec()),
            ctime: (info.ctime(), info.ctime_nsec()),
        }
    }
    pub(crate) fn named(parent: &fs::File, name: &std::ffi::OsStr) -> Result<Self> {
        let value: native::EntryStat = native::entry_stat(parent, name)?;
        Ok(Self {
            device: value.device,
            inode: value.inode,
            mode: value.mode,
            uid: value.uid,
            links: value.links,
            size: value.size,
            mtime: value.mtime,
            ctime: value.ctime,
        })
    }
    pub(crate) fn private(&self, owner: u32) -> bool {
        self.mode & libc::S_IFMT == libc::S_IFREG
            && self.mode & 0o7777 == 0o600
            && self.uid == owner
            && self.links == 1
    }
}
