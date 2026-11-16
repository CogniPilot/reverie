//! Same bounded FD mount-ID/backing-coordinate observation used by the host
//! reservation kernel. This establishes observed path overlap, not exclusion of
//! independent host processes, open descriptors or hardlink writers.
use super::*;
use reverie_contracts::{
    kernel_accounting,
    kernel_mounts::{MAX_MOUNT_BYTES, MountDevice, MountTable},
};
use reverie_core::posix_path::PosixPath;
use std::os::fd::AsRawFd;
const UNSUPPORTED: &str = "DEPLOYMENT_LIVE_ACCOUNT_HOST_MOUNT_UNSUPPORTED";

#[derive(Clone, PartialEq, Eq)]
pub(super) struct Location {
    pub(super) device: MountDevice,
    pub(super) path: PosixPath,
}
pub(super) struct Backing {
    paths: [PathBuf; 2],
    files: Vec<File>,
    namespace: PathBuf,
    locations: [Location; 2],
}
fn text(path: &Path, maximum: usize) -> Result<String> {
    let mut file = File::open(path)?;
    let result = (|| {
        let mut text = String::new();
        (&mut file)
            .take((maximum + 1) as u64)
            .read_to_string(&mut text)?;
        require(text.len() <= maximum, UNSUPPORTED)?;
        Ok(text)
    })();
    DeploymentError::finalized(result, close(file))
}
fn path(value: &Path) -> Result<PosixPath> {
    let value = value
        .to_str()
        .ok_or_else(|| DeploymentError::new(UNSUPPORTED))?;
    Ok(PosixPath::from_scalar_text(value))
}
fn location(file: &File, canonical: &Path, table: &MountTable) -> Result<Location> {
    let raw = text(
        Path::new(&format!("/proc/self/fdinfo/{}", file.as_raw_fd())),
        65_536,
    )?;
    let id = kernel_accounting::mount_id(&raw).map_err(|_| DeploymentError::new(UNSUPPORTED))?;
    let rows: Vec<_> = table.rows().iter().filter(|row| row.id() == &id).collect();
    require(rows.len() == 1, UNSUPPORTED)?;
    let row = rows[0];
    let m = file.metadata()?;
    let device = MountDevice::from_native(
        nix::sys::stat::major(m.dev()),
        nix::sys::stat::minor(m.dev()),
    );
    require(row.device() == &device, UNSUPPORTED)?;
    let suffix = path(canonical)?
        .relative_to(row.point())
        .ok_or_else(|| DeploymentError::new(UNSUPPORTED))?;
    let root = row
        .root()
        .ok_or_else(|| DeploymentError::new(UNSUPPORTED))?;
    Ok(Location {
        device,
        path: root.join(&suffix),
    })
}
fn selection(paths: &[PathBuf; 2], files: &[File]) -> Result<(PathBuf, [Location; 2])> {
    let namespace = fs::read_link("/proc/self/ns/mnt")?;
    let raw = text(Path::new("/proc/self/mountinfo"), MAX_MOUNT_BYTES)?;
    let table = MountTable::parse(&raw.chars().map(u32::from).collect::<Vec<_>>())
        .map_err(|_| DeploymentError::new(UNSUPPORTED))?;
    let locations = [
        location(&files[0], &paths[0], &table)?,
        location(&files[1], &paths[1], &table)?,
    ];
    let source = path(&paths[0])?;
    let console = path(&paths[1])?;
    let overlap = locations[0].device == locations[1].device
        && locations[0].path.overlaps(&locations[1].path);
    if let Some(relative) = source.relative_to(&console) {
        // A declared account path cannot itself be an alias to other console data.
        require(
            locations[0].device == locations[1].device
                && locations[0].path == locations[1].path.join(&relative),
            UNSUPPORTED,
        )?;
    } else {
        require(!overlap, UNSUPPORTED)?;
    }
    // Conservative supported profile: no nested host mounts beneath any RW
    // directory grant. A disjoint outer filesystem cannot hide console aliases.
    if files[0].metadata()?.is_dir() {
        require(
            !table
                .rows()
                .iter()
                .any(|row| row.point() != &source && row.point().is_relative_to(&source)),
            UNSUPPORTED,
        )?;
    }
    require(
        fs::read_link("/proc/self/ns/mnt")? == namespace,
        UNSUPPORTED,
    )?;
    Ok((namespace, locations))
}
impl Backing {
    pub(super) fn cgroup2_origin(&self) -> Result<Location> {
        use nix::sys::statfs::{
            self, BTRFS_SUPER_MAGIC, CGROUP2_SUPER_MAGIC, EXT4_SUPER_MAGIC, NFS_SUPER_MAGIC,
            OVERLAYFS_SUPER_MAGIC, TMPFS_MAGIC, XFS_SUPER_MAGIC,
        };
        self.verify()?;
        let source =
            statfs::fstatfs(&self.files[0]).map_err(|_| DeploymentError::new(UNSUPPORTED))?;
        let console =
            statfs::fstatfs(&self.files[1]).map_err(|_| DeploymentError::new(UNSUPPORTED))?;
        require(
            source.filesystem_type() == CGROUP2_SUPER_MAGIC
                && [
                    EXT4_SUPER_MAGIC,
                    BTRFS_SUPER_MAGIC,
                    XFS_SUPER_MAGIC,
                    TMPFS_MAGIC,
                    OVERLAYFS_SUPER_MAGIC,
                    NFS_SUPER_MAGIC,
                ]
                .contains(&console.filesystem_type())
                && self.locations[0].device != self.locations[1].device,
            UNSUPPORTED,
        )?;
        let raw = text(Path::new("/proc/self/mountinfo"), MAX_MOUNT_BYTES)?;
        let table = MountTable::parse(&raw.chars().map(u32::from).collect::<Vec<_>>())
            .map_err(|_| DeploymentError::new(UNSUPPORTED))?;
        let console = path(&self.paths[1])?;
        require(
            !table
                .rows()
                .iter()
                .any(|row| row.point() != &console && row.point().is_relative_to(&console)),
            UNSUPPORTED,
        )?;
        require(
            fs::read_link("/proc/self/ns/mnt")? == self.namespace,
            UNSUPPORTED,
        )?;
        Ok(self.locations[0].clone())
    }
    pub(super) fn capture(source: &Path, console: &Path) -> Result<Self> {
        let paths = [source.canonicalize()?, console.canonicalize()?];
        let mut files = Vec::new();
        let result = (|| {
            for path in &paths {
                files.push(
                    open(
                        path,
                        OFlag::O_PATH | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
                        Mode::empty(),
                    )
                    .map(File::from)
                    .map_err(|_| DeploymentError::new(UNSUPPORTED))?,
                );
            }
            selection(&paths, &files)
        })();
        match result {
            Ok((namespace, locations)) => Ok(Self {
                paths,
                files,
                namespace,
                locations,
            }),
            Err(error) => DeploymentError::finalized(Err(error), close_all(files)),
        }
    }
    pub(super) fn verify(&self) -> Result<()> {
        let current = Self::capture(&self.paths[0], &self.paths[1])?;
        let result = (|| {
            require(
                current.namespace == self.namespace && current.locations == self.locations,
                UNSUPPORTED,
            )?;
            for (old, fresh) in self.files.iter().zip(&current.files) {
                require(same(&old.metadata()?, &fresh.metadata()?), UNSUPPORTED)?;
            }
            Ok(())
        })();
        DeploymentError::finalized(result, current.close())
    }
    pub(super) fn close(self) -> Result<()> {
        close_all(self.files)
    }
}
