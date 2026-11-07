//! Fixed post-create record publication. Every partial native owner remains
//! inside the actual created resource record; no error unlinks by name.
mod file;
#[cfg(test)]
pub(super) mod test_hooks;
use super::*;
use crate::{
    native,
    worker_child::{ChildCleanup, LaunchDirectory, RecordDisposition},
};
use reverie_core::ids::NativeOperationId;
use std::{
    fs::{self, File},
    io::Write,
    os::{fd::AsRawFd, unix::fs::DirBuilderExt},
    path::PathBuf,
};

pub(super) struct Publication {
    root: PathBuf,
    runtime: PathBuf,
    uid: u32,
    nonce: Option<NativeOperationId>,
    parent: Option<LaunchDirectory>,
    runtime_parent: Option<LaunchDirectory>,
    writer: Option<File>,
    anchor: Option<File>,
    metadata: Option<File>,
    metadata_anchor: Option<File>,
    record_stamp: Option<native::Stamp>,
    metadata_stamp: Option<native::Stamp>,
    record_created: bool,
    metadata_attempted: bool,
    complete: bool,
    opaque: bool,
}
impl Publication {
    fn new(root: PathBuf, runtime: PathBuf, uid: u32) -> Self {
        Self {
            root,
            runtime,
            uid,
            nonce: None,
            parent: None,
            runtime_parent: None,
            writer: None,
            anchor: None,
            metadata: None,
            metadata_anchor: None,
            record_stamp: None,
            metadata_stamp: None,
            record_created: false,
            metadata_attempted: false,
            complete: false,
            opaque: false,
        }
    }
    fn parent(&self) -> &LaunchDirectory {
        self.parent.as_ref().expect("held launch parent")
    }
    fn runtime_parent(&self) -> &LaunchDirectory {
        self.runtime_parent.as_ref().expect("held runtime parent")
    }
    pub(super) fn nonce(&self) -> &NativeOperationId {
        self.nonce.as_ref().expect("fresh actual UUID")
    }
    fn name(&self) -> String {
        format!("{}.json", self.nonce().as_str())
    }
    fn write(&mut self, bytes: &[u8]) -> Result<()> {
        match fs::DirBuilder::new().mode(0o700).create(&self.root) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(LaptopError::Io(error)),
        }
        self.parent = Some(
            LaunchDirectory::open_for_uid(&self.root, self.uid)
                .map_err(LaptopError::Publication)?,
        );
        let mut entropy = [0; 16];
        getrandom::getrandom(&mut entropy)
            .map_err(|error| LaptopError::Io(std::io::Error::other(error.to_string())))?;
        self.nonce = Some(NativeOperationId::from_random_bytes(entropy));
        self.parent().recheck().map_err(LaptopError::Publication)?;
        self.writer = Some(
            native::open_at_mode(
                self.parent().file().as_raw_fd(),
                self.name().as_ref(),
                libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NONBLOCK,
                0o600,
            )
            .map_err(LaptopError::Io)?,
        );
        self.record_created = true;
        self.anchor = Some(
            native::open_at(
                self.parent().file().as_raw_fd(),
                self.name().as_ref(),
                libc::O_PATH,
            )
            .map_err(LaptopError::Io)?,
        );
        self.write_record(bytes)?;
        #[cfg(test)]
        test_hooks::after_record_write();
        // Source closes the exclusive json.dump writer BEFORE runtime.json.
        file::close(&mut self.writer, &mut self.opaque)?;
        self.record_current()?;
        self.write_metadata()?;
        self.record_current()?;
        Ok(())
    }
    fn write_record(&mut self, bytes: &[u8]) -> Result<()> {
        let writer = self.writer.as_mut().expect("owned exclusive record");
        writer.write_all(bytes).map_err(LaptopError::Io)?;
        writer.sync_all().map_err(LaptopError::Io)?;
        self.record_stamp = Some(file::private_record(writer, self.uid)?);
        self.record_current()
    }
    fn record_current(&self) -> Result<()> {
        self.parent().recheck().map_err(LaptopError::Publication)?;
        file::current(
            self.parent().file(),
            self.name().as_ref(),
            self.anchor.as_ref().expect("record anchor"),
            self.record_stamp.as_ref().expect("written record stamp"),
        )
    }
    fn write_metadata(&mut self) -> Result<()> {
        self.runtime_parent = Some(
            LaunchDirectory::open_for_uid(&self.runtime, self.uid)
                .map_err(LaptopError::Publication)?,
        );
        self.metadata = Some(
            native::open_at_mode(
                self.runtime_parent().file().as_raw_fd(),
                "runtime.json".as_ref(),
                libc::O_WRONLY | libc::O_CREAT | libc::O_NONBLOCK,
                0o666,
            )
            .map_err(LaptopError::Io)?,
        );
        self.metadata_anchor = Some(
            native::open_at(
                self.runtime_parent().file().as_raw_fd(),
                "runtime.json".as_ref(),
                libc::O_PATH,
            )
            .map_err(LaptopError::Io)?,
        );
        // Refuse pre-existing aliases BEFORE truncate. This is not atomic
        // exclusion from same-UID link/rename writers; actual lifecycle owns it.
        file::metadata_target(self.metadata.as_ref().expect("metadata writer"), self.uid)?;
        let before = native::Stamp::of(
            &self
                .metadata
                .as_ref()
                .expect("writer")
                .metadata()
                .map_err(LaptopError::Io)?,
        );
        file::current(
            self.runtime_parent().file(),
            "runtime.json".as_ref(),
            self.metadata_anchor.as_ref().expect("anchor"),
            &before,
        )?;
        self.runtime_parent()
            .recheck()
            .map_err(LaptopError::Publication)?;
        self.metadata_attempted = true;
        let bytes = reverie_contracts::worker_launch::runtime_metadata(self.nonce());
        let writer = self
            .metadata
            .as_mut()
            .expect("owned runtime metadata writer");
        writer.set_len(0).map_err(LaptopError::Io)?;
        writer.write_all(&bytes).map_err(LaptopError::Io)?;
        writer.sync_all().map_err(LaptopError::Io)?;
        self.metadata_stamp = Some(native::Stamp::of(
            &writer.metadata().map_err(LaptopError::Io)?,
        ));
        file::close(&mut self.metadata, &mut self.opaque)?;
        self.runtime_parent()
            .recheck()
            .map_err(LaptopError::Publication)?;
        file::current(
            self.runtime_parent().file(),
            "runtime.json".as_ref(),
            self.metadata_anchor.as_ref().expect("anchor"),
            self.metadata_stamp.as_ref().expect("written metadata"),
        )
    }
    fn finish_native(&mut self, mut result: Result<()>) -> Result<()> {
        self.opaque |= result
            .as_ref()
            .is_err_and(|error| error.unconfirmed_native());
        for slot in [
            &mut self.writer,
            &mut self.metadata,
            &mut self.anchor,
            &mut self.metadata_anchor,
        ] {
            result = finalized(result, file::close(slot, &mut self.opaque));
        }
        for parent in [self.parent.take(), self.runtime_parent.take()]
            .into_iter()
            .flatten()
        {
            let closed = parent
                .finish(
                    Ok(()),
                    RecordDisposition::Delegated,
                    ChildCleanup::RecordDirectoryClose,
                )
                .map_err(LaptopError::Publication);
            #[cfg(test)]
            let closed = finalized(closed, test_hooks::after_actual_close());
            self.opaque |= closed.is_err();
            result = finalized(result, closed);
        }
        self.complete = result.is_ok() && !self.opaque;
        result
    }
    pub(super) fn confirmed(&self) -> bool {
        self.complete && !self.opaque
    }
}
impl Workflows {
    fn publish(&self, runtime: &WorkerRuntime, created: &CreatedLaptop) -> Result<()> {
        self.bound(runtime, &created.workflow)?;
        let mut record = created
            .workflow
            .record
            .try_lock()
            .map_err(|_| LaptopError::Refused("WORKER_LAPTOP_RETAINED"))?;
        need(
            record.phase == Phase::Known
                && record
                    .creation
                    .as_ref()
                    .is_some_and(|state| state.stage == create::CreateStage::Created),
            "WORKER_LAPTOP_PUBLICATION_PHASE",
        )?;
        let resources = record.resources();
        let root = resources.plan.storage().home().join(".reverie-launch");
        let runtime_root = resources
            .nix
            .runtime_directory()
            .map_err(LaptopError::Nix)?;
        let bytes = reverie_contracts::worker_child::encode_launch_record(&resources.request);
        let state = record.creation.as_mut().expect("actual created owner");
        state.stage = create::CreateStage::Publishing;
        state.publication = Some(Publication::new(
            root,
            runtime_root,
            runtime.worker_identity().ids().uid(),
        ));
        let publication = state
            .publication
            .as_mut()
            .expect("registered publisher before first write");
        let result = publication.write(&bytes);
        let result = publication.finish_native(result);
        if result.is_ok() {
            state.stage = create::CreateStage::Published;
        }
        if publication.opaque {
            record.unknown = true;
        }
        match result {
            Ok(()) => Ok(()),
            Err(error) => {
                let error = Arc::new(error);
                record.outcome = Some(Err(error.clone()));
                Err(LaptopError::Recorded(error))
            }
        }
    }
}
impl WorkerRuntime {
    /// Fixed publication after actual create and before start. Protected App
    /// caller first publishes its real created receipt; this method grants none.
    pub fn publish_laptop_launch(&self, created: &CreatedLaptop) -> Result<()> {
        self.laptop_workflows().publish(self, created)
    }
}
impl Drop for Publication {
    fn drop(&mut self) {
        // The normal publisher checked all its descriptors before success.
        // This fallback only consumes any slots left by unwind; no ACK results.
        // Never unlink failed/foreign names from Drop or retry consumed closes.
        for slot in [
            &mut self.writer,
            &mut self.metadata,
            &mut self.anchor,
            &mut self.metadata_anchor,
        ] {
            if file::close(slot, &mut self.opaque).is_err() {
                self.opaque = true;
            }
        }
        for parent in [self.parent.take(), self.runtime_parent.take()]
            .into_iter()
            .flatten()
        {
            if parent
                .finish(
                    Ok(()),
                    RecordDisposition::Delegated,
                    ChildCleanup::RecordDirectoryClose,
                )
                .is_err()
            {
                self.opaque = true;
            }
        }
    }
}
