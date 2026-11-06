use super::{IdentityError, IdentityFault, Result, finalized, need};
use crate::private_fs::{self, CloseRole, Stamp};
use reverie_contracts::storage_identity::{Metadata, decode_metadata};
use std::ffi::OsStr;
use std::fs::{self, File};
use std::io::{self, Read};
use std::os::fd::AsRawFd;
use std::os::unix::fs::MetadataExt;
use std::path::{Component, Path, PathBuf};

pub const DEFAULT_METADATA_LIMIT: usize = 16 * 1024 * 1024;
/// Lexically canonical absolute native path data. Observed symlink aliases
/// refuse; nonexistent or inaccessible tails remain unresolved, as in Python
/// resolve(strict=False). This is not inode custody or proof of a usable path.
pub fn canonical(path: &Path) -> Result<PathBuf> {
    need(path.is_absolute(), IdentityFault::CanonicalPath)?;
    let mut checked = PathBuf::new();
    for component in path.components() {
        need(
            matches!(component, Component::RootDir | Component::Normal(_)),
            IdentityFault::CanonicalPath,
        )?;
        checked.push(component.as_os_str());
    }
    need(
        checked.as_os_str() == path.as_os_str(),
        IdentityFault::CanonicalPath,
    )?;
    let mut prefix = PathBuf::new();
    for component in checked.components() {
        prefix.push(component.as_os_str());
        match fs::symlink_metadata(&prefix) {
            Ok(info) => need(!info.file_type().is_symlink(), IdentityFault::CanonicalPath)?,
            Err(error)
                if error.kind() == io::ErrorKind::NotFound
                    || error.kind() == io::ErrorKind::PermissionDenied
                    || error.raw_os_error() == Some(libc::ENOTDIR) =>
            {
                break;
            }
            Err(error) => return Err(error.into()),
        }
    }
    Ok(checked)
}
/// Read owned, single-link, non-group/world-writable regular metadata. This is
/// deliberately distinct from the profile store's mode0600/euid-only contract.
pub fn read_metadata(path: &Path, uid: u32, maximum: usize) -> Result<Metadata> {
    let path = canonical(path)?;
    let mut file = open_read(&path)?;
    let value = read_current(&mut file, &path, uid, maximum);
    finalized(value, private_fs::close(file, CloseRole::Data, &path))
}
fn read_current(file: &mut File, path: &Path, uid: u32, maximum: usize) -> Result<Metadata> {
    let before = file.metadata()?;
    need(
        before.is_file()
            && before.uid() == uid
            && before.nlink() == 1
            && before.mode() & 0o022 == 0,
        IdentityFault::MetadataCustody,
    )?;
    need(before.len() <= maximum as u64, IdentityFault::MetadataBound)?;
    #[cfg(test)]
    tests_hit(super::tests::Point::BeforeRead, path)?;
    let limit = maximum
        .checked_add(1)
        .ok_or(IdentityError::Refused(IdentityFault::MetadataBound))?;
    let mut bytes = Vec::new();
    file.take(limit as u64).read_to_end(&mut bytes)?;
    need(bytes.len() <= maximum, IdentityFault::MetadataBound)?;
    #[cfg(test)]
    tests_hit(super::tests::Point::AfterRead, path)?;
    let after = file.metadata()?;
    let named = fs::symlink_metadata(path)?;
    canonical(path)?;
    need(
        bytes.len() as u64 == before.len()
            && Stamp::from_metadata(&before) == Stamp::from_metadata(&after)
            && Stamp::from_metadata(&after) == Stamp::from_metadata(&named),
        IdentityFault::MetadataChanged,
    )?;
    Ok(decode_metadata(&bytes)?)
}
#[cfg(test)]
fn tests_hit(point: super::tests::Point, path: &Path) -> Result<()> {
    super::tests::hit(point, path)
}
fn open_read(path: &Path) -> Result<File> {
    let mut parent = private_fs::open_at(
        libc::AT_FDCWD,
        OsStr::new("/"),
        libc::O_PATH | libc::O_DIRECTORY,
        0,
    )?;
    let components: Vec<_> = path.components().skip(1).collect();
    for (index, component) in components.iter().enumerate() {
        // Metadata lookup needs search permission on ancestors, not directory
        // listing permission. The actual data leaf remains a readable fd.
        let flags = if index + 1 == components.len() {
            libc::O_RDONLY | libc::O_NONBLOCK
        } else {
            libc::O_PATH | libc::O_DIRECTORY
        };
        let next = private_fs::open_at(parent.as_raw_fd(), component.as_os_str(), flags, 0);
        let closed = private_fs::close(parent, CloseRole::Walk, path);
        parent = match (next, closed) {
            (Ok(child), Ok(())) => child,
            (Err(error), closed) => return finalized(Err(IdentityError::Io(error)), closed),
            (Ok(child), Err(error)) => {
                return finalized(
                    Err(IdentityError::Custody(error)),
                    private_fs::close(child, CloseRole::Walk, path),
                );
            }
        };
    }
    Ok(parent)
}
