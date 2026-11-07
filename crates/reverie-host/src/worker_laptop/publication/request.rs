//! Exact original request-inode custody. Namespace mutation is excluded by
//! the real stopped/unissued record, lease and App lifecycle, not by stat alone.
use super::*;
use std::{ffi::OsStr, os::unix::fs::MetadataExt, path::Path};
pub(in crate::worker_laptop) enum Disposition {
    Preserve,
    Unlink,
}
#[derive(Default)]
pub(super) struct Custody {
    anchor: Option<File>,
    captured: bool,
    outcome: Option<std::result::Result<(), Arc<LaptopError>>>,
}
impl Custody {
    pub(super) fn capture(&mut self, writer: &File, anchor: &File, uid: u32) -> Result<()> {
        need(
            !self.captured && self.anchor.is_none(),
            "WORKER_REQUEST_CUSTODY_REPLAYED",
        )?;
        let written = writer.metadata().map_err(LaptopError::Io)?;
        let held = anchor.metadata().map_err(LaptopError::Io)?;
        need(
            written.is_file()
                && held.is_file()
                && written.uid() == uid
                && written.dev() == held.dev()
                && written.ino() == held.ino(),
            "WORKER_REQUEST_CUSTODY_CHANGED",
        )?;
        self.anchor = Some(anchor.try_clone().map_err(LaptopError::Io)?);
        self.captured = true;
        Ok(())
    }
    pub(super) fn require_closed(&self, owned: bool) -> Result<()> {
        need(
            self.anchor.is_none()
                && (!owned || self.captured)
                && self.outcome.as_ref().is_some_and(|outcome| outcome.is_ok()),
            "WORKER_REQUEST_CLOSE_UNCONFIRMED",
        )
    }
    pub(super) fn finish(
        &mut self,
        root: &Path,
        name: &OsStr,
        uid: u32,
        owned: bool,
        disposition: Disposition,
    ) -> Result<()> {
        if let Some(outcome) = &self.outcome {
            return outcome
                .as_ref()
                .copied()
                .map_err(|error| LaptopError::Recorded(error.clone()));
        }
        let result = if owned {
            self.anchor
                .as_ref()
                .ok_or(LaptopError::Refused("WORKER_REQUEST_CUSTODY_UNAVAILABLE"))
                .and_then(|anchor| match disposition {
                    Disposition::Unlink => remove(root, name, anchor, uid),
                    Disposition::Preserve => Ok(()),
                })
        } else {
            Ok(())
        };
        let mut opaque = false;
        let result = finalized(result, file::close(&mut self.anchor, &mut opaque));
        match result {
            Ok(()) => {
                self.outcome = Some(Ok(()));
                Ok(())
            }
            Err(error) => {
                let error = Arc::new(error);
                self.outcome = Some(Err(error.clone()));
                Err(LaptopError::Recorded(error))
            }
        }
    }
    pub(super) fn close_abandoned(&mut self) -> Result<()> {
        let mut opaque = false;
        file::close(&mut self.anchor, &mut opaque)
    }
}
fn remove(root: &Path, name: &OsStr, anchor: &File, uid: u32) -> Result<()> {
    // This check deliberately grants no protection from a hostile concurrent
    // same-UID writer. The actual App lifecycle and retained storage lease must
    // exclude competing namespace producers before this fixed cleanup purpose.
    if let Err(error) = fs::symlink_metadata(root) {
        if error.kind() == std::io::ErrorKind::NotFound {
            return Ok(());
        }
        return Err(LaptopError::Io(error));
    }
    let parent = LaunchDirectory::open_for_uid(root, uid).map_err(LaptopError::Publication)?;
    let result = remove_leaf(&parent, name, anchor, uid);
    finalized(
        result,
        parent
            .finish(
                Ok(()),
                RecordDisposition::Delegated,
                ChildCleanup::RecordDirectoryClose,
            )
            .map_err(LaptopError::Publication),
    )
}
fn remove_leaf(parent: &LaunchDirectory, name: &OsStr, anchor: &File, uid: u32) -> Result<()> {
    let named = match native::open_at(parent.file().as_raw_fd(), name, libc::O_PATH) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(LaptopError::Io(error)),
    };
    let result = (|| {
        let expected = file::private_record(anchor, uid)?;
        let actual = file::private_record(&named, uid)?;
        need(expected == actual, "WORKER_REQUEST_REPLACED")?;
        parent.recheck().map_err(LaptopError::Publication)?;
        native::unlink_child_record(parent.file(), name).map_err(LaptopError::Io)
    })();
    finalized(
        result,
        native::close(named).map_err(LaptopError::Observation),
    )
}
