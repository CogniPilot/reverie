//! Canonical pre-Nix cold prerequisites over the actual storage owner.
//! This neither clears/retires temporary data nor grants a native start.
use super::*;
use nix::sys::stat::{Mode, mkdirat};
use reverie_contracts::worker_validation::WorkerValidationData;
use std::{ffi::OsStr, os::unix::fs::MetadataExt};

const PENDING: &str = "cold-tmp-cleanup.pending.json";

impl LaunchStorage {
    /// A pending name, including a broken symlink, fences every new preparation.
    /// Unknown metadata is refused rather than treated as an absent marker.
    pub fn require_no_cold_pending(&self) -> OwnerResult<()> {
        self.check_resource_current()?;
        match std::fs::symlink_metadata(self.paths.root().join(PENDING)) {
            Ok(_) => Err(StorageOwnerError::Refused(
                "WORKER_COLD_RECONCILIATION_REQUIRED",
            )),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(StorageOwnerError::Path(error)),
        }
    }

    /// Observe actual home absence, prepare this owner's storage, then initialize
    /// leases only for a genuinely new home and an enabled captured cold policy.
    /// Existing homes are never repaired implicitly. The caller retains this box.
    pub fn prepare_cold_launch_storage(&mut self) -> OwnerResult<()> {
        self.require_no_cold_pending()?;
        let fresh = match std::fs::symlink_metadata(self.paths.home()) {
            Ok(_) => false,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => true,
            Err(error) => return Err(StorageOwnerError::Path(error)),
        };
        let enabled = WorkerValidationData::new(&self.source)
            .cold()
            .map_err(|_| StorageOwnerError::Refused("WORKER_COLD_POLICY"))?
            .is_some();
        crate::worker_validation::observe_cold_policy(&self.source)
            .map_err(StorageOwnerError::Cold)?;
        let uid = Configuration::capture(&self.source)
            .map_err(StorageOwnerError::Storage)?
            .uid();
        self.prepare_storage()?;
        if !enabled || !fresh {
            return Ok(());
        }
        // The actual preparation above created the previously absent home.
        let mut effects = true;
        let initialized = initialize(self.paths.home(), uid, &mut effects);
        let initialized = partial(initialized, effects).map_err(StorageOwnerError::Storage);
        let current = self.check_resource_current().map(|_| ());
        match (initialized, current) {
            (Ok(()), Ok(())) => Ok(()),
            (Err(primary), Err(secondary)) => Err(StorageOwnerError::Finalized {
                primary: Box::new(primary),
                secondary: vec![secondary],
            }),
            (Err(error), Ok(())) | (Ok(()), Err(error)) => Err(error),
        }
    }
}

fn initialize(home: &Path, uid: u32, effects: &mut bool) -> Result<()> {
    let mut held = vec![native::open_at(
        nix::libc::AT_FDCWD,
        home.as_os_str(),
        nix::libc::O_RDONLY | nix::libc::O_DIRECTORY,
    )?];
    let result = (|| {
        super::super::temporary::private(held.last().expect("home owner"), uid)?;
        for name in [".local", "state", "reverie", "leases"] {
            let parent = held.last().expect("held parent");
            match mkdirat(parent, name, Mode::S_IRWXU) {
                Ok(()) => {
                    *effects = true;
                    parent.sync_all()?;
                }
                Err(nix::errno::Errno::EEXIST) => {}
                Err(error) => return Err(std::io::Error::from(error).into()),
            }
            let child = native::open_at(
                std::os::fd::AsRawFd::as_raw_fd(parent),
                OsStr::new(name),
                nix::libc::O_RDONLY | nix::libc::O_DIRECTORY,
            )?;
            held.push(child);
            super::super::temporary::private(held.last().expect("adopted child"), uid)?;
        }
        let named = std::fs::symlink_metadata(home)?;
        let original = held[0].metadata()?;
        need(
            named.is_dir() && named.dev() == original.dev() && named.ino() == original.ino(),
            StorageFault::TemporaryChanged,
        )
    })();
    let mut result = result;
    while let Some(file) = held.pop() {
        result = finalized(result, fs::close(file));
    }
    result
}
