//! Shared eight-field private-file DATA. No path custody or effect authority.
use std::{fs::Metadata, os::unix::fs::MetadataExt};
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct PrivateFileStamp {
    device: u64,
    inode: u64,
    mode: u32,
    uid: u32,
    links: u64,
    size: u64,
    mtime: (i64, i64),
    ctime: (i64, i64),
}
impl PrivateFileStamp {
    pub(crate) fn of(info: &Metadata) -> Self {
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
    pub(crate) fn named(parent: &std::fs::File, name: &std::ffi::OsStr) -> std::io::Result<Self> {
        let value = super::entry_stat(parent, name)?;
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
