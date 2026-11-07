use super::fd::path_text;
use super::*;
use reverie_contracts::{
    storage_identity::MetadataText,
    worker_cold_tmp::{ReferenceMapRow, ReferenceUnixRow},
};
use std::collections::BTreeMap;
impl Observer<'_> {
    pub(super) fn link(&mut self, base: &Path, kind: ReferenceLink) -> Result<()> {
        check(self.end)?;
        let node = base.join(kind.name());
        let mut held = None;
        let mut link = None;
        let observed = (|| {
            held = Some(std::fs::metadata(&node)?);
            link = Some(path_text(std::fs::read_link(&node)?));
            Ok(())
        })();
        match observed {
            Ok(()) => {}
            Err(error) if vanished(&error) => return Ok(()),
            Err(error) if denied(&error) => self.unknown(UnknownReference::Link(kind))?,
            Err(error) => return Err(error),
        }
        if self.matches(held.as_ref(), link.as_ref(), None)? {
            self.known(KnownReference::Link(kind))?;
        }
        Ok(())
    }
    pub(super) fn maps(&mut self, base: &Path) -> Result<()> {
        let raw = match read(&base.join("maps"), 4 << 20, self.end) {
            Ok(raw) => raw,
            Err(error) if denied(&error) => {
                self.unknown(UnknownReference::MapInventory)?;
                return Ok(());
            }
            Err(error) => return Err(error),
        };
        self.report.note_maps(raw.len())?;
        for row in ReferenceMapRow::parse(&raw)? {
            check(self.end)?;
            if row.zero_inode() {
                continue;
            }
            let device = row.device();
            let device = nix::sys::stat::makedev(u64::from(device.0), u64::from(device.1));
            if device != self.target.key.0 {
                continue;
            }
            if row.path().is_none() {
                self.unknown(UnknownReference::MapPath)?;
            }
            if row
                .inode()
                .is_some_and(|inode| inode.as_str() == self.target.key.1.to_string())
                || self.matches(None, row.path(), None)?
            {
                self.known(KnownReference::Mapped)?;
            }
        }
        Ok(())
    }
    pub(super) fn unix(&mut self, base: &Path, sockets: &BTreeSet<UnsignedInteger>) -> Result<()> {
        let raw = match read(&base.join("net/unix"), 4 << 20, self.end) {
            Ok(raw) => raw,
            Err(error) if denied(&error) => {
                self.unknown(UnknownReference::SocketMetadata)?;
                return Ok(());
            }
            Err(error) => return Err(error),
        };
        self.report.note_unix(raw.len())?;
        let paths = group(ReferenceUnixRow::parse(&raw)?);
        for paths in &paths.ordered {
            for path in paths {
                self.unix_path(path)?;
            }
        }
        for inode in sockets {
            check(self.end)?;
            let selected = paths
                .indices
                .get(inode)
                .map(|&index| paths.ordered[index].as_slice())
                .unwrap_or(&[]);
            self.socket_paths(selected)?;
        }
        Ok(())
    }
    fn unix_path(&mut self, path: &MetadataText) -> Result<()> {
        check(self.end)?;
        if !matches!(path.codepoints().first(), Some(47 | 64)) {
            self.unknown(UnknownReference::RelativeUnixPath)?;
        }
        if self.matches(None, Some(path), None)? {
            self.known(KnownReference::NamespaceSocket)?;
        }
        Ok(())
    }
    fn socket_paths(&mut self, paths: &[MetadataText]) -> Result<()> {
        for path in paths {
            if self.matches(None, Some(path), None)? {
                self.known(KnownReference::Socket)?;
                return Ok(());
            }
        }
        if paths.is_empty() {
            self.unknown(UnknownReference::SocketNamespace)?;
        }
        Ok(())
    }
}
struct UnixPaths {
    indices: BTreeMap<UnsignedInteger, usize>,
    ordered: Vec<Vec<MetadataText>>,
}
fn group(rows: Vec<ReferenceUnixRow>) -> UnixPaths {
    let mut indices = BTreeMap::new();
    let mut result = Vec::new();
    for row in rows {
        let Some(path) = row.path() else {
            continue;
        };
        let index = *indices.entry(row.inode().clone()).or_insert_with(|| {
            let index = result.len();
            result.push(Vec::new());
            index
        });
        result[index].push(path.clone());
    }
    UnixPaths {
        indices,
        ordered: result,
    }
}
