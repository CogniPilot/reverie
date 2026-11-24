//! Reuses the fixed kernel reader, fdinfo identity and shared mount parser.
//! Coordinates detect aliases; they confer no writer/mount authority.
//!
//! A snapshot depends on the mounts that decide where its own paths resolve
//! and what lies beneath them. `Scope` names those paths. A mount is relevant
//! when its mount point is one of them, lies above one of them, or lies
//! inside one of them. Every relevant row must stay exactly as first captured:
//! the alias proof in `disjoint` was computed from those rows, and a mount
//! placed on, above or inside a snapshot path can shadow or replace what the
//! copy reads and writes. Mounts everywhere else, such as another container's
//! root filesystem or network namespace, cannot change either and are ignored.
use super::{Result, SnapshotError, require};
use crate::{native, reservation_kernel::ReservationKernel};
use reverie_contracts::kernel_mounts::{MountDevice, MountRow, MountTable};
use reverie_core::{decimal::UnsignedInteger, posix_path::PosixPath};
use std::{collections::BTreeMap, path::Path, time::Instant};
#[cfg(test)]
mod tests;

/// Held descriptors, the mount table and descriptor identities are all read
/// through this filesystem.
const PROCESS_FILESYSTEM: &str = "/proc";

pub(super) fn capture(end: Instant) -> Result<MountTable> {
    ReservationKernel::new()
        .mount_table(end)
        .map_err(|error| SnapshotError::caused("SNAPSHOT_MOUNT_OBSERVATION", error))
}

/// The paths a snapshot resolves, walks or executes from. Lexical comparison
/// is exact here because every path is canonical in the observer's namespace,
/// as kernel mount points are.
pub(super) struct Scope(Vec<PosixPath>);
impl Scope {
    /// Start with what every snapshot uses: the process filesystem and the
    /// store holding the installed tools and their libraries.
    pub(super) fn fixed() -> Self {
        Self(
            [PROCESS_FILESYSTEM, super::process::TOOL_STORE]
                .map(PosixPath::from_scalar_text)
                .to_vec(),
        )
    }
    /// Add a canonical directory the snapshot reads from or writes into.
    pub(super) fn include(&mut self, path: &Path) -> Result<()> {
        let path = text(path)?;
        require(path.is_single_rooted(), "SNAPSHOT_MOUNT_PATH")?;
        if !self.0.contains(&path) {
            self.0.push(path);
        }
        Ok(())
    }
    fn relevant(&self, row: &MountRow) -> bool {
        self.0.iter().any(|path| path.overlaps(row.point()))
    }
    fn rows<'a>(&self, table: &'a MountTable) -> BTreeMap<&'a UnsignedInteger, &'a MountRow> {
        table
            .rows()
            .iter()
            .filter(|row| self.relevant(row))
            .map(|row| (row.id(), row))
            .collect()
    }
    /// Every relevant mount keeps its identity, parent, device, root, mount
    /// point and filesystem type, and no relevant mount appears or disappears.
    /// Stacking is carried by the parent identity, so row order is not compared.
    pub(super) fn unchanged(&self, before: &MountTable, after: &MountTable) -> bool {
        self.rows(before) == self.rows(after)
    }
}

/// The table a snapshot's alias proofs were computed from, with the paths
/// those proofs and the copy itself depend on.
pub(super) struct Observed {
    table: MountTable,
    scope: Scope,
}
impl Observed {
    pub(super) fn capture(end: Instant) -> Result<Self> {
        Ok(Self {
            table: capture(end)?,
            scope: Scope::fixed(),
        })
    }
    /// Bring a canonical directory under the comparison before using it.
    pub(super) fn include(&mut self, path: &Path) -> Result<()> {
        self.scope.include(path)
    }
    pub(super) fn disjoint(&self, source: &Path, parent: &Path) -> Result<()> {
        disjoint(source, parent, &self.table)
    }
    /// Refuse when any mount on, above or inside an included path differs
    /// from the captured table. Unrelated mounts may come and go.
    pub(super) fn require_current(&self, end: Instant) -> Result<()> {
        require(
            self.scope.unchanged(&self.table, &capture(end)?),
            "SNAPSHOT_MOUNTS_CHANGED",
        )
    }
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
