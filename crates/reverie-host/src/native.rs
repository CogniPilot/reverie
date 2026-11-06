//! Narrow Linux read-only syscall boundary. Purpose wrappers own path and
//! metadata policies; these helpers never supply authorization or write files.
#![allow(unsafe_code)]

use crate::observation::{ObservationError, ObservationFault, Result, finalized, need};
use std::ffi::CStr;
use std::fs::{self, File, Metadata, OpenOptions};
use std::io::Read;
use std::os::fd::IntoRawFd;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
mod control;
mod lease;
mod passwd;
mod reservation;
pub(crate) use control::{HeldAdmission, control_directory, open_admission};
pub(crate) use lease::observe_ops_private;
pub(crate) use lease::observe_with_ancestors;
pub(crate) use reservation::{read_reservation, reservation_identity, reservation_location};
mod text;
pub(crate) use text::{python_path, python_text};
mod resolve;
mod worker_config;
pub(crate) use passwd::username;
pub(crate) use resolve::{resolve_optional_text, resolve_strict_text};
pub(crate) use worker_config::read_worker_config;

#[derive(Clone, Debug, Eq, PartialEq)]
struct Stamp {
    device: u64,
    inode: u64,
    uid: u32,
    gid: u32,
    mode: u32,
    links: u64,
    size: u64,
    mtime: (i64, i64),
    ctime: (i64, i64),
}
impl Stamp {
    fn of(metadata: &Metadata) -> Self {
        Self {
            device: metadata.dev(),
            inode: metadata.ino(),
            uid: metadata.uid(),
            gid: metadata.gid(),
            mode: metadata.mode(),
            links: metadata.nlink(),
            size: metadata.len(),
            mtime: (metadata.mtime(), metadata.mtime_nsec()),
            ctime: (metadata.ctime(), metadata.ctime_nsec()),
        }
    }
}
pub(crate) fn uid() -> u32 {
    // SAFETY: getuid takes no arguments and returns the process real UID.
    unsafe { libc::getuid() }
}
pub(crate) fn system() -> Result<(String, String)> {
    // SAFETY: initialized utsname provides valid writable ABI output storage.
    let mut value: libc::utsname = unsafe { std::mem::zeroed() };
    if unsafe { libc::uname(&mut value) } != 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    // SAFETY: successful uname terminates these fixed-size character arrays.
    let system = unsafe { CStr::from_ptr(value.sysname.as_ptr()) }
        .to_str()
        .map_err(|_| ObservationError::Refused(ObservationFault::System))?
        .to_owned();
    let machine = unsafe { CStr::from_ptr(value.machine.as_ptr()) }
        .to_str()
        .map_err(|_| ObservationError::Refused(ObservationFault::System))?
        .to_owned();
    Ok((system, machine))
}
pub(crate) fn canonical_in(path: &Path, root: &Path) -> Result<PathBuf> {
    let bytes = path.as_os_str().as_bytes();
    need(
        !bytes.starts_with(b"//") || bytes.starts_with(b"///"),
        ObservationFault::CanonicalPath,
    )?;
    let path: PathBuf = path.components().collect();
    need(
        path.is_absolute()
            && path.starts_with(root)
            && path != root
            && fs::canonicalize(&path)? == path,
        ObservationFault::CanonicalPath,
    )?;
    Ok(path)
}
pub(crate) fn observe(
    path: &Path,
    maximum: usize,
    allowed: impl Fn(&Metadata) -> bool,
) -> Result<Vec<u8>> {
    Ok(observe_snapshot(path, maximum, allowed)?.bytes)
}
pub(crate) struct Snapshot {
    pub(crate) bytes: Vec<u8>,
    pub(crate) metadata: Metadata,
}
pub(crate) fn observe_snapshot(
    path: &Path,
    maximum: usize,
    allowed: impl Fn(&Metadata) -> bool,
) -> Result<Snapshot> {
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
        .open(path)?;
    let result = read_snapshot(&mut file, path, maximum, allowed);
    finalized(result, close(file))
}
fn read_snapshot(
    file: &mut File,
    path: &Path,
    maximum: usize,
    allowed: impl Fn(&Metadata) -> bool,
) -> Result<Snapshot> {
    let before = file.metadata()?;
    need(
        before.is_file() && allowed(&before),
        ObservationFault::ArtifactCustody,
    )?;
    need(
        before.len() <= maximum as u64,
        ObservationFault::ArtifactBound,
    )?;
    let limit = maximum
        .checked_add(1)
        .ok_or(ObservationError::Refused(ObservationFault::ArtifactBound))?;
    let mut bytes = Vec::new();
    (&mut *file).take(limit as u64).read_to_end(&mut bytes)?;
    #[cfg(test)]
    test_faults::after_read(path)?;
    let after = file.metadata()?;
    let named = fs::symlink_metadata(path)?;
    need(
        bytes.len() as u64 == before.len()
            && bytes.len() <= maximum
            && Stamp::of(&before) == Stamp::of(&after)
            && Stamp::of(&before) == Stamp::of(&named),
        ObservationFault::Changed,
    )?;
    Ok(Snapshot {
        bytes,
        metadata: after,
    })
}
pub(crate) fn close(file: File) -> Result<()> {
    let fd = file.into_raw_fd();
    // SAFETY: sole descriptor ownership is consumed before this one close.
    let result = if unsafe { libc::close(fd) } == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error().into())
    };
    #[cfg(test)]
    let result = finalized(result, test_faults::closed());
    result
}

#[cfg(test)]
pub(crate) mod test_faults {
    use super::*;
    use std::cell::RefCell;
    type Hook = Box<dyn FnMut(&Path) -> Result<()>>;
    #[derive(Default)]
    struct Faults {
        hook: Option<Hook>,
        close: bool,
    }
    thread_local! {static STATE:RefCell<Faults>=RefCell::new(Faults::default());}
    pub(crate) fn after_read(path: &Path) -> Result<()> {
        let hook = STATE.with(|state| state.borrow_mut().hook.take());
        match hook {
            Some(mut hook) => hook(path),
            None => Ok(()),
        }
    }
    pub(super) fn closed() -> Result<()> {
        if STATE.with(|state| std::mem::take(&mut state.borrow_mut().close)) {
            Err(std::io::Error::other("owned injected close failure").into())
        } else {
            Ok(())
        }
    }
    pub(crate) fn set(hook: Option<Hook>, close: bool) {
        STATE.with(|state| *state.borrow_mut() = Faults { hook, close });
    }
}

#[cfg(test)]
mod tests;
