//! Preparation-policy stat/rename primitives and fixed file-opening purposes.
//! Names are selected by the retained purpose owner, never wire. Creation uses
//! the single existing openat owner shared with storage and readonly callers.
use std::os::unix::fs::MetadataExt;
use std::{
    ffi::{CString, OsStr},
    fs::File,
    io,
    os::{fd::AsRawFd, unix::ffi::OsStrExt},
};
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct PolicyEntryStamp {
    pub(crate) device: u64,
    pub(crate) inode: u64,
    pub(crate) size: u64,
    pub(crate) mtime: (i64, i64),
    pub(crate) ctime: (i64, i64),
}
impl PolicyEntryStamp {
    pub(crate) fn of(metadata: &std::fs::Metadata) -> Self {
        Self {
            device: metadata.dev(),
            inode: metadata.ino(),
            size: metadata.len(),
            mtime: (metadata.mtime(), metadata.mtime_nsec()),
            ctime: (metadata.ctime(), metadata.ctime_nsec()),
        }
    }
}
pub(crate) fn policy_effective_uid() -> u32 {
    // SAFETY: geteuid takes no arguments and returns this process's effective UID.
    unsafe { libc::geteuid() }
}
pub(crate) fn open_policy_original(parent: &File, name: &OsStr) -> io::Result<File> {
    super::lease::open_at(parent.as_raw_fd(), name, libc::O_RDONLY | libc::O_NONBLOCK)
}
pub(crate) fn open_policy_child_directory(parent: &File, name: &OsStr) -> io::Result<File> {
    super::lease::open_at(parent.as_raw_fd(), name, libc::O_RDONLY | libc::O_DIRECTORY)
}
pub(crate) fn named_policy_entry(parent: &File, name: &OsStr) -> io::Result<PolicyEntryStamp> {
    let data = entry_stat(parent, name)?;
    Ok(PolicyEntryStamp {
        device: data.device,
        inode: data.inode,
        size: data.size,
        mtime: data.mtime,
        ctime: data.ctime,
    })
}
/// One no-follow named-entry syscall owner. Individual purposes retain their
/// actual source signature: policy uses five fields; GPU includes mode/uid/link
/// count as well. This metadata itself is not current custody or permission.
pub(crate) struct EntryStat {
    pub(crate) device: u64,
    pub(crate) inode: u64,
    pub(crate) size: u64,
    pub(crate) mode: u32,
    pub(crate) uid: u32,
    pub(crate) links: u64,
    pub(crate) mtime: (i64, i64),
    pub(crate) ctime: (i64, i64),
}
pub(crate) fn entry_stat(parent: &File, name: &OsStr) -> io::Result<EntryStat> {
    let name = CString::new(name.as_bytes()).map_err(|_| io::ErrorKind::InvalidInput)?;
    let mut data = std::mem::MaybeUninit::<libc::stat>::uninit();
    // SAFETY: name and parent remain live; data points to writable stat ABI
    // output storage. No metadata is read unless fstatat reports success.
    let status = unsafe {
        libc::fstatat(
            parent.as_raw_fd(),
            name.as_ptr(),
            data.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    };
    if status != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: successful fstatat initialized every stat field consumed below.
    let data = unsafe { data.assume_init() };
    Ok(EntryStat {
        device: data.st_dev,
        inode: data.st_ino,
        size: u64::try_from(data.st_size).map_err(|_| io::ErrorKind::InvalidData)?,
        mtime: (data.st_mtime, data.st_mtime_nsec),
        ctime: (data.st_ctime, data.st_ctime_nsec),
        mode: data.st_mode,
        uid: data.st_uid,
        links: data.st_nlink,
    })
}
pub(crate) fn create_policy_temporary(parent: &File, name: &OsStr) -> io::Result<File> {
    super::lease::open_at_mode(
        parent.as_raw_fd(),
        name,
        libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL,
        0o600,
    )
}
pub(crate) fn replace_policy(parent: &File, temporary: &OsStr, target: &OsStr) -> io::Result<()> {
    let temporary = CString::new(temporary.as_bytes()).map_err(|_| io::ErrorKind::InvalidInput)?;
    let target = CString::new(target.as_bytes()).map_err(|_| io::ErrorKind::InvalidInput)?;
    // SAFETY: both names and the same borrowed directory stay live throughout
    // renameat. It returns no descriptor and performs only this exact rename.
    let status = unsafe {
        libc::renameat(
            parent.as_raw_fd(),
            temporary.as_ptr(),
            parent.as_raw_fd(),
            target.as_ptr(),
        )
    };
    if status == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}
/// Initial actor setup publishes only this fixed absent leaf. Reuse the native
/// no-replace owner so a newly appeared actor is never overwritten.
pub(crate) fn publish_absent_actor_policy(
    parent: &File,
    temporary: &OsStr,
    target: &OsStr,
) -> io::Result<()> {
    if target != OsStr::new("resource-actor.json") {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    let from = CString::new(temporary.as_bytes()).map_err(|_| io::ErrorKind::InvalidInput)?;
    let to = CString::new(target.as_bytes()).map_err(|_| io::ErrorKind::InvalidInput)?;
    super::rename::noreplace(parent, &from, parent, &to)
}
