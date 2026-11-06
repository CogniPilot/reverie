//! Purpose-specific reservation directory/admission observations. The syscall
//! owner is the existing open_at/close boundary; no authority comes from JSON.
#![forbid(unsafe_code)]
use super::*;
use reverie_contracts::reservation_control::ControlIdentity;
use reverie_core::posix_path::PosixPath;
use std::os::fd::AsRawFd;
pub(crate) struct ControlDirectorySnapshot {
    pub(crate) device: u64,
    pub(crate) inode: u64,
}
pub(crate) fn control_directory(path: &PosixPath, owner: u32) -> Result<ControlDirectorySnapshot> {
    let file = directory(path, owner)?;
    let result = (|| {
        let metadata = file.metadata()?;
        need(
            metadata.uid() == owner && metadata.mode() & 0o7777 == 0o700,
            ObservationFault::ControlDirectory,
        )?;
        Ok(ControlDirectorySnapshot {
            device: metadata.dev(),
            inode: metadata.ino(),
        })
    })();
    finalized(result, close(file))
}
fn directory(path: &PosixPath, owner: u32) -> Result<File> {
    need(
        path.is_single_rooted() && !path.has_parent_component(),
        ObservationFault::ControlPath,
    )?;
    let native = python_path(&path.codepoints())?;
    let mut parent = lease::open_at(
        libc::AT_FDCWD,
        std::ffi::OsStr::new("/"),
        libc::O_RDONLY | libc::O_DIRECTORY,
    )?;
    for component in native.components().skip(1) {
        let next = lease::open_at(
            parent.as_raw_fd(),
            component.as_os_str(),
            libc::O_RDONLY | libc::O_DIRECTORY,
        );
        let closed = close(parent);
        parent = match (next, closed) {
            (Ok(child), Ok(())) => child,
            (Err(error), closed) => return finalized(Err(error.into()), closed),
            (Ok(child), Err(error)) => return finalized(Err(error), close(child)),
        };
        if let Err(error) = ancestor(&parent, owner) {
            return finalized(Err(error), close(parent));
        }
    }
    Ok(parent)
}
fn ancestor(file: &File, owner: u32) -> Result<()> {
    let metadata = file.metadata()?;
    let sticky = metadata.uid() == 0 && metadata.mode() & libc::S_ISVTX != 0;
    need(
        (metadata.uid() == 0 || metadata.uid() == owner)
            && (metadata.mode() & 0o022 == 0 || sticky),
        ObservationFault::ControlAncestor,
    )
}
pub(crate) struct HeldAdmission {
    file: Option<File>,
    path: PathBuf,
}
pub(crate) fn open_admission(root: &PosixPath) -> Result<HeldAdmission> {
    let path = python_path(
        &root
            .join(&PosixPath::from_scalar_text("admission.lock"))
            .codepoints(),
    )?;
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK)
        .open(&path)?;
    let locked = match file.try_lock() {
        Ok(()) => Ok(()),
        Err(std::fs::TryLockError::WouldBlock) => {
            Err(ObservationError::Refused(ObservationFault::AdmissionBusy))
        }
        Err(std::fs::TryLockError::Error(error)) => Err(error.into()),
    };
    if let Err(error) = locked {
        return finalized(Err(error), close(file));
    }
    Ok(HeldAdmission {
        file: Some(file),
        path,
    })
}
impl HeldAdmission {
    pub(crate) fn assert_current(&self, expected: &ControlIdentity, owner: u32) -> Result<()> {
        let file = self.file.as_ref().ok_or(ObservationError::Refused(
            ObservationFault::AdmissionRequired,
        ))?;
        let held = file.metadata()?;
        let named = fs::symlink_metadata(&self.path)?;
        need(
            expected.matches_native(held.dev(), held.ino())
                && held.dev() == named.dev()
                && held.ino() == named.ino()
                && held.mode() & 0o7777 == 0o600
                && held.uid() == owner
                && held.nlink() == 1,
            ObservationFault::AdmissionRebound,
        )
    }
    pub(crate) fn close(&mut self) -> Result<()> {
        self.file.take().map_or(Ok(()), close)
    }
}
