//! A restore test on a separately selected owner disk. The durable archive
//! stays with the deployment operation.
use super::{Directory, Result, combine, mounts, require};
use std::{fs, os::unix::fs::MetadataExt, path::Path, time::Instant};

pub struct RehearsalRoot(Directory);

impl RehearsalRoot {
    /// Pin an existing private directory before stopping the office.
    pub fn open(path: &Path, source: &Path, operation: &Path, end: Instant) -> Result<Self> {
        require(
            path.is_absolute() && fs::canonicalize(path)? == path,
            "SNAPSHOT_REHEARSAL_ROOT",
        )?;
        let directory = Directory::open(path)?;
        let admitted = (|| {
            let metadata = directory.file().metadata()?;
            require(
                metadata.uid() == crate::native::uid() && metadata.mode() & 0o777 == 0o700,
                "SNAPSHOT_DESTINATION_CUSTODY",
            )?;
            require(
                fs::read_dir(directory.fd_path())?
                    .next()
                    .transpose()?
                    .is_none(),
                "SNAPSHOT_REHEARSAL_OCCUPIED",
            )?;
            let table = mounts::capture(end)?;
            for other in [source, operation] {
                mounts::disjoint(&fs::canonicalize(other)?, path, &table)?;
            }
            directory.check()
        })();
        match admitted {
            Ok(()) => Ok(Self(directory)),
            Err(error) => combine(Err(error), directory.close()),
        }
    }

    pub fn capture(
        &self,
        tools: &super::SnapshotTools,
        source: &Path,
        end: Instant,
    ) -> Result<super::ConsoleSnapshot> {
        self.0.check()?;
        let snapshot = tools.capture_console(source, &self.0.path().join("snapshot"), end)?;
        match self.0.check() {
            Ok(()) => Ok(snapshot),
            Err(error) => combine(Err(error), snapshot.close()),
        }
    }

    pub fn close(self) -> Result<()> {
        self.0.close()
    }

    pub(super) fn directory(&self) -> &Directory {
        &self.0
    }
}
