//! Narrow Linux syscall boundary. Purpose wrappers own metadata and write
//! policies; these helpers never supply authorization or effect permission.
#![allow(unsafe_code)]

use crate::observation::{ObservationError, ObservationFault, Result, finalized, need};
use std::ffi::CStr;
use std::fs::{self, File, Metadata, OpenOptions};
use std::io::Read;
use std::os::fd::IntoRawFd;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
mod child_record;
pub(crate) mod child_signals;
mod cold_temporary;
mod control;
#[cfg(test)]
pub(crate) mod interrupted_test;
mod lease;
mod memory_namespace;
mod memory_profile;
pub(crate) mod metadata_socket;
mod rename;
pub(crate) mod socket_entry;
pub(crate) mod worker_directory;
pub(crate) use cold_temporary::{
    install as install_cold_temporary, retire as retire_cold_temporary,
};
pub(crate) mod ordered_exec;
pub(crate) mod owned_process;
pub(crate) mod viewer_session;
pub(crate) use child_record::unlink as unlink_child_record;
pub(crate) use child_record::{
    create_private as create_child_receipt, publish as publish_child_receipt,
};
pub(crate) use lease::open_at;
pub(crate) use lease::open_at_mode;
pub(crate) use memory_namespace::memory_credentials;
pub(crate) use memory_namespace::{memory_lock, memory_lock_entry, memory_lock_file};
mod passwd;
pub(crate) use memory_profile::publish as publish_memory_profile;
pub(crate) use memory_profile::{
    create as create_memory_profile, entry as memory_profile_entry, remove as remove_memory_profile,
};
mod reservation;
pub(crate) use control::{
    ControlDirectorySnapshot, HeldAdmission, control_directory, held_control_directory,
    open_admission,
};
mod policy;
pub(crate) mod private_goal;
pub(crate) use lease::observe_ops_private;
pub(crate) use lease::observe_with_ancestors;
pub(crate) use policy::{
    EntryStat, PolicyEntryStamp, create_policy_temporary, entry_stat, named_policy_entry,
    open_policy_child_directory, open_policy_original, policy_effective_uid, replace_policy,
};
pub(crate) use reservation::{
    read_reservation, reservation_identity, reservation_identity_text, reservation_location,
};
mod text;
pub(crate) use text::{python_is_file, python_path, python_text};
mod office;
mod office_listener;
pub(crate) use office_listener::OfficeListenerReady;
mod resolve;
mod worker_config;
pub(crate) use office::office_plan_capability;
pub(crate) use passwd::home_directory;
pub(crate) use passwd::username;
pub(crate) use resolve::{resolve_optional_text, resolve_strict_text};
pub(crate) use worker_config::read_owned_text_file as read_nix_rollback;
pub(crate) use worker_config::read_worker_config;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct Stamp {
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
    pub(crate) fn matches_rename_metadata(&self, other: &Self) -> bool {
        self.device == other.device
            && self.inode == other.inode
            && self.uid == other.uid
            && self.gid == other.gid
            && self.mode == other.mode
            && self.links == other.links
            && self.size == other.size
            && self.mtime == other.mtime
    }
    pub(crate) fn of(metadata: &Metadata) -> Self {
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
    let value = uname()?;
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
pub(crate) fn kernel_release() -> Result<String> {
    let value = uname()?;
    // SAFETY: successful uname terminates this fixed-size ABI character array;
    // the owned utsname stays live for the whole CStr/UTF8 conversion.
    unsafe { CStr::from_ptr(value.release.as_ptr()) }
        .to_str()
        .map(str::to_owned)
        .map_err(|_| ObservationError::Refused(ObservationFault::System))
}
fn uname() -> Result<libc::utsname> {
    // SAFETY: initialized utsname provides valid writable ABI output storage.
    let mut value: libc::utsname = unsafe { std::mem::zeroed() };
    if unsafe { libc::uname(&mut value) } != 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(value)
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
