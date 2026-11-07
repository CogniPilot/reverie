use super::*;
use reverie_contracts::{kernel_mounts, storage_identity::MetadataText};
use std::collections::BTreeMap;
// Original _index_table: preserve duplicate points as ambiguity, while fixed
// indexes avoid rescanning all mounts for every FD, map and socket path.
pub(super) struct IndexedMounts {
    table: MountTable,
    ids: BTreeMap<UnsignedInteger, Vec<usize>>,
    points: BTreeMap<Vec<u32>, Vec<usize>>,
}
impl IndexedMounts {
    pub(super) fn new(table: MountTable) -> Self {
        let mut ids: BTreeMap<UnsignedInteger, Vec<usize>> = BTreeMap::new();
        let mut points: BTreeMap<Vec<u32>, Vec<usize>> = BTreeMap::new();
        for (index, row) in table.rows().iter().enumerate() {
            ids.entry(row.id().clone()).or_default().push(index);
            points
                .entry(row.point().codepoints())
                .or_default()
                .push(index);
        }
        Self { table, ids, points }
    }
    fn rows(&self, path: &PosixPath, mount: Option<&UnsignedInteger>) -> Option<&[usize]> {
        if let Some(mount) = mount {
            return self.ids.get(mount).map(Vec::as_slice);
        }
        let mut parent = path.clone();
        loop {
            if let Some(rows) = self.points.get(&parent.codepoints()) {
                return Some(rows);
            }
            let next = parent.parent();
            if next == parent {
                return None;
            }
            parent = next;
        }
    }
}
impl Observer<'_> {
    pub(super) fn matches(
        &mut self,
        held: Option<&std::fs::Metadata>,
        link: Option<&MetadataText>,
        mount: Option<&UnsignedInteger>,
    ) -> Result<bool> {
        check(self.end)?;
        if let Some(info) = held {
            if (info.dev(), info.ino()) == self.target.key {
                return Ok(true);
            }
            if info.dev() != self.target.key.0 {
                return Ok(false);
            }
        }
        let Some(link) = link else {
            return Ok(false);
        };
        let points = link.codepoints();
        if points.first() != Some(&47) {
            return Ok(false);
        }
        let suffix = " (deleted)".chars().map(u32::from).collect::<Vec<_>>();
        let points = points.strip_suffix(suffix.as_slice()).unwrap_or(points);
        let Ok(path) = kernel_mounts::decode_path(points) else {
            return Ok(false);
        };
        if let (Some(table), Some(mount)) = (&self.table, mount)
            && !table.ids.contains_key(mount)
        {
            self.unknown(UnknownReference::DetachedFdMount)?;
            return Ok(false);
        }
        let coordinate = coordinate(&path, self.table.as_ref(), mount)?;
        let Some(coordinate) = coordinate else {
            self.unknown(UnknownReference::Coordinates)?;
            return Ok(false);
        };
        if let Some(held) = held {
            need(
                coordinate.0
                    == MountDevice::from_native(
                        u64::from(libc::major(held.dev())),
                        u64::from(libc::minor(held.dev())),
                    ),
                StorageFault::ColdReference,
            )?;
        }
        Ok(coordinate.0 == self.target.coordinate.0
            && coordinate.1.is_relative_to(&self.target.coordinate.1))
    }
}
fn coordinate(
    path: &PosixPath,
    table: Option<&IndexedMounts>,
    mount: Option<&UnsignedInteger>,
) -> Result<Option<(MountDevice, PosixPath)>> {
    let Some(table) = table else {
        return Ok(None);
    };
    let Some(rows) = table.rows(path, mount) else {
        return Ok(None);
    };
    need(rows.len() == 1, StorageFault::ColdReference)?;
    let row = &table.table.rows()[rows[0]];
    let Some(root) = row.root() else {
        return Ok(None);
    };
    let Some(relative) = path.relative_to(row.point()) else {
        return Ok(None);
    };
    Ok(Some((row.device().clone(), root.join(&relative))))
}
