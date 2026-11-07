//! Fixed observer read primitives and O_PATH identities. No writes, leases or
//! process signals. All File descriptors receive explicit fallible finalization.
use super::*;
use reverie_contracts::kernel_accounting;
use reverie_contracts::kernel_mounts::MountDevice;
use reverie_core::{decimal::UnsignedInteger, posix_path::PosixPath};
pub(crate) fn read_reservation(path: &Path, maximum: usize) -> Result<Vec<u8>> {
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_CLOEXEC | libc::O_NONBLOCK)
        .open(path)?;
    let value = (|| {
        let mut bytes = Vec::new();
        (&mut file)
            .take(
                maximum
                    .checked_add(1)
                    .ok_or_else(|| std::io::Error::from(std::io::ErrorKind::InvalidInput))?
                    as u64,
            )
            .read_to_end(&mut bytes)?;
        need(bytes.len() <= maximum, ObservationFault::ReservationBound)?;
        Ok(bytes)
    })();
    finalized(value, close(file))
}
pub(crate) fn reservation_identity(path: &PosixPath) -> Result<[u64; 4]> {
    reservation_identity_text(&path.codepoints())
}
/// _identity(str) keeps its raw spelling; pathlib normalization belongs to the
/// separate canonical comparison, not to this final no-follow open.
pub(crate) fn reservation_identity_text(points: &[u32]) -> Result<[u64; 4]> {
    let file = path_file_text(points)?;
    let result = (|| {
        let info = file.metadata()?;
        need(info.is_dir(), ObservationFault::ReservationStorageDirectory)?;
        Ok([
            info.dev(),
            info.ino(),
            u64::from(info.uid()),
            u64::from(info.gid()),
        ])
    })();
    finalized(result, close(file))
}
pub(crate) fn reservation_location(path: &PosixPath) -> Result<(UnsignedInteger, MountDevice)> {
    let file = path_file(path)?;
    let result = (|| {
        use std::os::fd::AsRawFd;
        let raw = read_reservation(
            &PathBuf::from(format!("/proc/self/fdinfo/{}", file.as_raw_fd())),
            65_536,
        )?;
        let raw = std::str::from_utf8(&raw)
            .map_err(|_| ObservationError::Refused(ObservationFault::System))?;
        let mount_id = kernel_accounting::mount_id(raw)
            .map_err(|_| ObservationError::Refused(ObservationFault::System))?;
        let info = file.metadata()?;
        Ok((
            mount_id,
            MountDevice::from_native(
                u64::from(libc::major(info.dev())),
                u64::from(libc::minor(info.dev())),
            ),
        ))
    })();
    finalized(result, close(file))
}
fn path_file(path: &PosixPath) -> Result<File> {
    path_file_text(&path.codepoints())
}
fn path_file_text(points: &[u32]) -> Result<File> {
    Ok(OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_PATH | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(python_path(points)?)?)
}
