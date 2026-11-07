//! Reuses the fixed kernel reader, fdinfo identity and shared mount parser.
//! Coordinates detect aliases; they confer no writer/mount authority.
use super::{Result, SnapshotError, require};
use crate::{native, reservation_kernel::ReservationKernel};
use reverie_contracts::kernel_mounts::{MountDevice, MountTable};
use reverie_core::posix_path::PosixPath;
use std::{path::Path, time::Instant};

pub(super) fn capture(end: Instant) -> Result<MountTable> {
    ReservationKernel::new()
        .mount_table(end)
        .map_err(|error| SnapshotError::caused("SNAPSHOT_MOUNT_OBSERVATION", error))
}
pub(super) fn disjoint(source: &Path, parent: &Path, table: &MountTable) -> Result<()> {
    let source = text(source)?;
    let parent = text(parent)?;
    let (sd, sr) = location(&source, table)?;
    let (dd, dr) = location(&parent, table)?;
    require(sd != dd || !sr.overlaps(&dr), "SNAPSHOT_MOUNT_ALIAS")?;
    for mount in table
        .rows()
        .iter()
        .filter(|row| row.point().is_relative_to(&source) && row.device() == &dd)
    {
        require(
            mount.root().is_some_and(|root| !root.overlaps(&dr)),
            "SNAPSHOT_NESTED_MOUNT_ALIAS",
        )?;
    }
    Ok(())
}
fn text(path: &Path) -> Result<PosixPath> {
    PosixPath::try_new(&native::python_text(path))
        .map_err(|_| SnapshotError::refused("SNAPSHOT_MOUNT_PATH"))
}
fn location(path: &PosixPath, table: &MountTable) -> Result<(MountDevice, PosixPath)> {
    let (id, device) = native::reservation_location(path)?;
    let row = table
        .rows()
        .iter()
        .find(|row| row.id() == &id)
        .ok_or_else(|| SnapshotError::refused("SNAPSHOT_MOUNT_BINDING"))?;
    require(row.device() == &device, "SNAPSHOT_MOUNT_BINDING")?;
    let suffix = path
        .relative_to(row.point())
        .ok_or_else(|| SnapshotError::refused("SNAPSHOT_MOUNT_BINDING"))?;
    let root = row
        .root()
        .ok_or_else(|| SnapshotError::refused("SNAPSHOT_MOUNT_BINDING"))?;
    Ok((device, root.join(&suffix)))
}
