//! One owner for Goal private-path permission and identity rules shared by the
//! policy-current reader and G's retained multi-entry batch. Facts grant no access.
use reverie_core::posix_path::PosixPath;
use std::{fs::Metadata, os::unix::fs::MetadataExt, path::Path};
pub(crate) type PathIdentity = (u64, u64, u32, u32, u32);
pub(crate) fn identity(info: &Metadata) -> PathIdentity {
    (info.dev(), info.ino(), info.uid(), info.mode(), info.gid())
}
pub(crate) fn path_available(path: &Path) -> bool {
    let text = super::python_text(path);
    let Ok(lexical) = PosixPath::try_new(&text) else {
        return false;
    };
    lexical.is_absolute()
        && lexical.codepoints() == text
        && !lexical.has_parent_component()
        && path != Path::new("/")
        && !text.iter().any(|point| [0, 10, 13].contains(point))
}
pub(crate) fn ancestry_available(info: &Metadata) -> bool {
    let sticky_root = info.uid() == 0 && info.mode() & libc::S_ISVTX != 0;
    [0, super::uid()].contains(&info.uid()) && (info.mode() & 0o022 == 0 || sticky_root)
}
pub(crate) fn parent_available(info: &Metadata) -> bool {
    info.uid() == super::uid() && info.mode() & 0o077 == 0
}
pub(crate) fn entry_available(info: &Metadata, directory: bool) -> bool {
    (if directory {
        info.is_dir()
    } else {
        info.is_file()
    }) && parent_available(info)
        && (directory || info.nlink() == 1)
}
pub(crate) fn projection(stamp: &super::PolicyEntryStamp) -> [String; 5] {
    [
        stamp.device.to_string(),
        stamp.inode.to_string(),
        stamp.size.to_string(),
        (i128::from(stamp.mtime.0) * 1_000_000_000 + i128::from(stamp.mtime.1)).to_string(),
        (i128::from(stamp.ctime.0) * 1_000_000_000 + i128::from(stamp.ctime.1)).to_string(),
    ]
}
