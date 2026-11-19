//! Check visible bind aliases for the existing offline-store workflow.
use super::Result;
use crate::native;
use reverie_contracts::{
    kernel_mounts::{MAX_VISIBLE_MOUNT_BYTES, visible_mount_points},
    worker_nix::offline_qualification::mounts::{inspected_binds, isolated_image_binds},
};
use std::{
    fs::{self, OpenOptions},
    io::{self, Read},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
};

#[cfg(test)]
mod tests;

type Inode = (u64, u64);
type Observer<'a> = &'a dyn Fn(&Path) -> io::Result<Option<Inode>>;
struct Mounts<'a> {
    points: Vec<PathBuf>,
    inode: Observer<'a>,
}

pub fn plan(
    controls: &[PathBuf],
    stores: &[PathBuf; 2],
    future: &[PathBuf],
    rows: &[u8],
) -> Result<()> {
    Mounts::read()?.plan(controls, stores, future, rows)
}

pub fn settled(stores: &[PathBuf; 2], rows: &[u8]) -> Result<()> {
    let mounts = Mounts::read()?;
    for item in inspected_binds(rows)? {
        if item.running_writer() && mounts.overlaps_any(&resolve(item.source())?, stores)? {
            return Err("employee data acquired a foreign writer".into());
        }
    }
    Ok(())
}

pub fn isolated_image(protected: &[PathBuf], row: &[u8], uid: u32, gid: u32) -> Result<()> {
    let binds = isolated_image_binds(row, uid, gid)?;
    let mounts = Mounts::read()?;
    for bind in binds {
        let source = resolve(bind.source())?;
        let metadata = fs::metadata(&source)?;
        if !metadata.is_file() && !metadata.is_dir() {
            return Err("offline image check cannot borrow sockets or devices".into());
        }
        let destination = native::python_path(bind.destination())?;
        if [
            "/home/agent",
            "/nix",
            "/instances",
            "/reverie_workspace",
            "/run",
        ]
        .iter()
        .any(|base| destination.starts_with(base))
        {
            return Err("offline image check cannot borrow private runtime mounts".into());
        }
        if mounts.overlaps_any(&source, protected)? {
            return Err("offline image check has private employee/account source".into());
        }
    }
    Ok(())
}

impl Mounts<'_> {
    fn read() -> Result<Self> {
        let mut bytes = Vec::new();
        OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NONBLOCK | libc::O_CLOEXEC)
            .open("/proc/self/mountinfo")?
            .take((MAX_VISIBLE_MOUNT_BYTES + 1) as u64)
            .read_to_end(&mut bytes)?;
        let points = visible_mount_points(&bytes)
            .map_err(|_| "mount metadata unavailable")?
            .iter()
            .map(|point| native::python_path(&point.codepoints()))
            .collect::<io::Result<_>>()?;
        Ok(Self {
            points,
            inode: &inode,
        })
    }

    fn plan(
        &self,
        controls: &[PathBuf],
        stores: &[PathBuf; 2],
        future: &[PathBuf],
        rows: &[u8],
    ) -> Result<()> {
        for item in inspected_binds(rows)? {
            let source = resolve(item.source())?;
            self.require_control_private(&source, controls)?;
            if item.running_writer() && self.overlaps_any(&source, stores)? {
                return Err("another running container owns employee data".into());
            }
        }
        for source in future {
            self.require_control_private(&resolve(&native::python_text(source))?, controls)?;
        }
        Ok(())
    }

    fn require_control_private(&self, source: &Path, controls: &[PathBuf]) -> Result<()> {
        if self.overlaps_any(source, controls)? {
            return Err("maintenance control is exposed through a container bind".into());
        }
        Ok(())
    }

    fn overlaps_any(&self, source: &Path, targets: &[PathBuf]) -> Result<bool> {
        for target in targets {
            if self.overlap(source, &resolve(&native::python_text(target))?)? {
                return Ok(true);
            }
        }
        Ok(false)
    }

    fn overlap(&self, source: &Path, protected: &Path) -> Result<bool> {
        let roots = std::iter::once(source).chain(
            self.points
                .iter()
                .filter(|point| point.starts_with(source))
                .map(PathBuf::as_path),
        );
        for root in roots {
            if root.starts_with(protected)
                || protected.starts_with(root)
                || self.physical_overlap(root, protected)?
            {
                return Ok(true);
            }
        }
        Ok(false)
    }

    fn physical_overlap(&self, left: &Path, right: &Path) -> Result<bool> {
        if left.components().count() > 128 || right.components().count() > 128 {
            return Err("path depth bound".into());
        }
        let a = (self.inode)(left)?;
        let b = (self.inode)(right)?;
        if let Some(b) = b
            && self.has_ancestor(left, b)?
        {
            return Ok(true);
        }
        Ok(a.map_or(Ok(false), |a| self.has_ancestor(right, a))?)
    }

    fn has_ancestor(&self, path: &Path, identity: Inode) -> io::Result<bool> {
        for parent in path.ancestors() {
            if (self.inode)(parent)? == Some(identity) {
                return Ok(true);
            }
        }
        Ok(false)
    }
}

fn resolve(points: &[u32]) -> io::Result<PathBuf> {
    native::python_path(&native::resolve_optional_text(points)?.codepoints())
}

fn inode(path: &Path) -> io::Result<Option<Inode>> {
    match fs::metadata(path) {
        Ok(info) => Ok(Some((info.dev(), info.ino()))),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}
