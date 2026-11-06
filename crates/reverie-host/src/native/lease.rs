//! Acceptance-company O_RDONLY ancestor traversal. Immutable artifact reads keep
//! their separate search-only/canonical policy, including execute-only dirs.
use super::{Snapshot, close, read_snapshot};
use crate::observation::{ObservationFault, Result, finalized, need};
use std::ffi::{CString, OsStr};
use std::fs::{File, Metadata};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::ffi::OsStrExt;
use std::path::{Component, Path};

pub(crate) fn observe_with_ancestors(
    path: &Path,
    maximum: usize,
    allowed: impl Fn(&Metadata) -> bool,
) -> Result<Snapshot> {
    need(
        path.is_absolute()
            && path
                .components()
                .all(|part| matches!(part, Component::RootDir | Component::Normal(_)))
            && path
                .components()
                .collect::<std::path::PathBuf>()
                .as_os_str()
                == path.as_os_str(),
        ObservationFault::CanonicalPath,
    )?;
    let parent_path = path.parent().ok_or(crate::ObservationError::Refused(
        ObservationFault::CanonicalPath,
    ))?;
    let name = path.file_name().ok_or(crate::ObservationError::Refused(
        ObservationFault::CanonicalPath,
    ))?;
    observe_at(path, parent_path, name, maximum, allowed, None)
}
pub(crate) fn observe_ops_private(path: &Path, maximum: usize, uid: u32) -> Result<Vec<u8>> {
    let parent = path.parent().ok_or(crate::ObservationError::Refused(
        ObservationFault::CanonicalPath,
    ))?;
    need(parent != Path::new("/"), ObservationFault::CanonicalPath)?;
    let name = path.file_name().ok_or(crate::ObservationError::Refused(
        ObservationFault::CanonicalPath,
    ))?;
    Ok(observe_at(
        path,
        parent,
        name,
        maximum,
        |m| {
            use std::os::unix::fs::MetadataExt;
            m.uid() == uid && m.nlink() == 1 && m.mode() & 0o077 == 0
        },
        Some(uid),
    )?
    .bytes)
}
fn observe_at(
    path: &Path,
    parent_path: &Path,
    name: &OsStr,
    maximum: usize,
    allowed: impl Fn(&Metadata) -> bool,
    directory_uid: Option<u32>,
) -> Result<Snapshot> {
    let parent = directory(parent_path, directory_uid)?;
    let opened = open_at(parent.as_raw_fd(), name, libc::O_RDONLY | libc::O_NONBLOCK);
    let result = match opened {
        Ok(mut file) => {
            let result = read_snapshot(&mut file, path, maximum, allowed);
            finalized(result, close(file))
        }
        Err(error) => Err(error.into()),
    };
    finalized(result, close(parent))
}
fn directory(path: &Path, uid: Option<u32>) -> Result<File> {
    let mut parent = open_at(
        libc::AT_FDCWD,
        OsStr::new("/"),
        libc::O_RDONLY | libc::O_DIRECTORY,
    )?;
    for component in path.components().skip(1) {
        let child = open_at(
            parent.as_raw_fd(),
            component.as_os_str(),
            libc::O_RDONLY | libc::O_DIRECTORY,
        );
        let closed = close(parent);
        parent = match (child, closed) {
            (Ok(child), Ok(())) => child,
            (Err(error), closed) => return finalized(Err(error.into()), closed),
            (Ok(child), Err(error)) => return finalized(Err(error), close(child)),
        };
        let checked = if let Some(uid) = uid {
            use std::os::unix::fs::MetadataExt;
            parent
                .metadata()
                .map_err(crate::ObservationError::from)
                .and_then(|metadata| {
                    need(
                        [0, uid].contains(&metadata.uid()) && metadata.mode() & 0o022 == 0,
                        ObservationFault::ArtifactCustody,
                    )
                })
        } else {
            Ok(())
        };
        if let Err(error) = checked {
            return finalized(Err(error), close(parent));
        }
    }
    if let Some(uid) = uid {
        use std::os::unix::fs::MetadataExt;
        let checked = parent
            .metadata()
            .map_err(crate::ObservationError::from)
            .and_then(|metadata| {
                need(
                    metadata.uid() == uid && metadata.mode() & 0o077 == 0,
                    ObservationFault::ArtifactCustody,
                )
            });
        if let Err(error) = checked {
            return finalized(Err(error), close(parent));
        }
    }
    Ok(parent)
}
pub(crate) fn open_at(parent: i32, name: &OsStr, flags: i32) -> std::io::Result<File> {
    let name = CString::new(name.as_bytes()).map_err(|_| std::io::ErrorKind::InvalidInput)?;
    // SAFETY: name remains a valid terminated byte string throughout openat;
    // parent is a borrowed live directory descriptor (or AT_FDCWD). These
    // read-only calls create no file; a successful result is one newly owned fd.
    let fd = unsafe {
        libc::openat(
            parent,
            name.as_ptr(),
            flags | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            0,
        )
    };
    if fd < 0 {
        Err(std::io::Error::last_os_error())
    } else {
        // SAFETY: successful openat returned this one owned fd, transferred once.
        Ok(unsafe { File::from_raw_fd(fd) })
    }
}
