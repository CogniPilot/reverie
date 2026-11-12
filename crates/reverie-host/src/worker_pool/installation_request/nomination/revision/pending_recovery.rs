//! One UNKNOWN denial-record archival. Only original R/IMAGE/native absence
//! owners permit the fixed no-replace move; no old outcome or replay is minted.
use super::publication::{private_directory, private_file};
use super::*;
use reverie_contracts::reservation_control::{ControlBinding, PoolTransitionIntent};
use reverie_core::operations::OperationScope;
use sha2::{Digest, Sha256};
use std::{ffi::OsStr, os::unix::fs::FileExt};

#[derive(Clone, Copy, Eq, PartialEq)]
enum Closure {
    Open,
    Closing,
    Closed,
    Unknown,
}
#[derive(Clone, Copy, Eq, PartialEq)]
enum Phase {
    Capturing,
    Prepared,
    MoveAttempted,
    Archived,
}
pub(super) struct PendingRecovery {
    expected: JournalDigest,
    phase: Phase,
    path: PathBuf,
    parent: Option<File>,
    parent_identity: Option<native::private_goal::PathIdentity>,
    original: Option<File>,
    stamp: Option<native::PrivateFileStamp>,
    raw: Vec<u8>,
    binding: Option<ControlBinding>,
    binding_stamp: Option<crate::gpu_access::GpuFileStamp>,
    intent: Option<PoolTransitionIntent>,
    admission: Option<crate::reservation_control::AdmissionLock>,
    history: Option<PathBuf>,
    receipt: Option<File>,
    receipt_stamp: Option<native::PrivateFileStamp>,
    closure: Closure,
}
impl PendingRecovery {
    pub(super) fn capture(expected: JournalDigest) -> Self {
        Self {
            expected,
            phase: Phase::Capturing,
            path: PathBuf::new(),
            parent: None,
            parent_identity: None,
            original: None,
            stamp: None,
            raw: Vec::new(),
            binding: None,
            binding_stamp: None,
            intent: None,
            admission: None,
            history: None,
            receipt: None,
            receipt_stamp: None,
            closure: Closure::Open,
        }
    }
    pub(super) fn observe(&mut self, owner: &NominationOwner) -> Result<()> {
        need(
            self.phase == Phase::Capturing && self.parent.is_none(),
            "POOL_PENDING_ALREADY_CAPTURED",
        )?;
        let source = owner.source.as_ref().expect("registered source");
        let files = GpuControlFiles::capture(source, owner.config.configuration());
        let binding = files.read_binding()?;
        self.binding_stamp = Some(binding.stamp().clone());
        self.binding = Some(
            ControlBinding::from_metadata(binding.metadata(), owner.config.configuration())
                .map_err(|_| PoolNominationError::Refused("POOL_PENDING_BINDING"))?,
        );
        self.admission = Some(
            crate::reservation_control::AdmissionLock::acquire(&owner.config)
                .map_err(PoolNominationError::from)?,
        );
        self.observe_file(owner)?;
        self.decode_original(owner)?;
        self.phase = Phase::Prepared;
        self.guard(owner)?;
        self.original_current(false)
    }
    fn observe_file(&mut self, owner: &NominationOwner) -> Result<()> {
        self.path = native::python_path(&owner.config.control_paths()?.pending().codepoints())?;
        let parent = self
            .path
            .parent()
            .ok_or(PoolNominationError::Refused("POOL_PENDING_PARENT"))?;
        self.parent = Some(native::open_at(
            nix::libc::AT_FDCWD,
            parent.as_os_str(),
            nix::libc::O_RDONLY | nix::libc::O_DIRECTORY,
        )?);
        let info = self.parent.as_ref().expect("same parent").metadata()?;
        private_directory(parent)?;
        need(
            self.binding
                .as_ref()
                .expect("original binding")
                .state_directory()
                .matches_native(info.dev(), info.ino()),
            "POOL_PENDING_STATE_DIRECTORY_CHANGED",
        )?;
        self.parent_identity = Some(native::private_goal::identity(&info));
        self.original = Some(native::open_policy_original(
            self.parent.as_ref().expect("same parent"),
            OsStr::new("resource-reservation-control.pending"),
        )?);
        let info = self.original.as_ref().expect("same original").metadata()?;
        private_file(&info, 1)?;
        need((1..=4096).contains(&info.len()), "POOL_PENDING_BOUND")?;
        self.stamp = Some(native::PrivateFileStamp::of(&info));
        self.raw.resize(info.len() as usize, 0);
        self.original
            .as_ref()
            .expect("original reader")
            .read_exact_at(&mut self.raw, 0)?;
        need(
            format!("{:x}", Sha256::digest(&self.raw)) == self.expected.as_str(),
            "POOL_PENDING_EXPECTED_DIGEST_CHANGED",
        )?;
        Ok(())
    }
    fn decode_original(&mut self, owner: &NominationOwner) -> Result<()> {
        let option = reverie_contracts::worker_validation::WorkerValidationData::new(
            owner.config.configuration(),
        )
        .reservation()
        .map_err(|_| PoolNominationError::Refused("POOL_PENDING_SCOPE"))?
        .ok_or(PoolNominationError::Refused("POOL_PENDING_SCOPE"))?;
        let scope = OperationScope {
            company_id: option.company().clone(),
            owner_scope_digest: option.owner_scope().clone(),
        };
        self.intent = Some(
            PoolTransitionIntent::decode_pending(
                &self.raw,
                &scope,
                self.binding.as_ref().expect("original binding"),
                owner.config.configuration(),
            )
            .map_err(|_| PoolNominationError::Refused("POOL_PENDING_DATA"))?,
        );
        Ok(())
    }
    fn guard(&self, owner: &NominationOwner) -> Result<()> {
        need(
            matches!(self.closure, Closure::Open | Closure::Closed) && Instant::now() < owner.end,
            "POOL_PENDING_UNCONFIRMED",
        )?;
        let source = owner.source.as_ref().expect("same source");
        if self.closure == Closure::Closed {
            let path = native::python_path(&owner.config.control_paths()?.binding().codepoints())?;
            need(
                self.binding_stamp.as_ref()
                    == Some(&crate::gpu_access::GpuFileStamp::observe(&path)?),
                "POOL_PENDING_BINDING_CHANGED",
            )?;
        } else {
            let current =
                GpuControlFiles::capture(source, owner.config.configuration()).read_binding()?;
            need(
                self.binding_stamp.as_ref() == Some(current.stamp())
                    && self
                        .binding
                        .as_ref()
                        .expect("original binding")
                        .matches_metadata(current.metadata()),
                "POOL_PENDING_BINDING_CHANGED",
            )?;
        }
        let parent = self.path.parent().expect("fixed pending parent");
        private_directory(parent)?;
        need(
            Some(native::private_goal::identity(&fs::symlink_metadata(
                parent,
            )?)) == self.parent_identity,
            "POOL_PENDING_PARENT_CHANGED",
        )?;
        if self.closure == Closure::Open {
            need(
                Some(native::private_goal::identity(
                    &self.parent.as_ref().expect("same parent").metadata()?,
                )) == self.parent_identity,
                "POOL_PENDING_PARENT_CHANGED",
            )?;
            self.admission
                .as_ref()
                .expect("same R")
                .assert_current(&owner.config, self.binding.as_ref().expect("same binding"))
                .map_err(PoolNominationError::from)?;
        }
        Ok(())
    }
    fn original_current(&self, renamed: bool) -> Result<()> {
        let path = if renamed {
            self.history
                .as_ref()
                .expect("same history")
                .join("pending-before.json")
        } else {
            self.path.clone()
        };
        let info = fs::symlink_metadata(path)?;
        private_file(&info, 1)?;
        let stamp = native::PrivateFileStamp::of(&info);
        need(
            if renamed {
                stamp.same_renamed_file(self.stamp.as_ref().expect("original stamp"))
            } else {
                Some(&stamp) == self.stamp.as_ref()
            },
            "POOL_PENDING_ORIGINAL_CHANGED",
        )?;
        if let Some(file) = &self.original {
            need(
                native::PrivateFileStamp::of(&file.metadata()?) == stamp,
                "POOL_PENDING_ORIGINAL_CHANGED",
            )?;
            let mut raw = vec![0; self.raw.len()];
            file.read_exact_at(&mut raw, 0)?;
            need(raw == self.raw, "POOL_PENDING_ORIGINAL_CHANGED")?;
        }
        Ok(())
    }
    pub(super) fn assert_before(&self, owner: &NominationOwner) -> Result<()> {
        need(self.phase == Phase::Prepared, "POOL_PENDING_NOT_PREPARED")?;
        self.guard(owner)?;
        self.original_current(false)?;
        owner
            .derived
            .as_ref()
            .expect("same native negative observations")
            .assert_retired_pending_policy(
                self.intent
                    .as_ref()
                    .expect("original pending DATA")
                    .pool_policy_digest(),
                owner.request.as_ref().expect("original request"),
            )
    }
    pub(super) fn archive(
        &mut self,
        owner: &NominationOwner,
        history: &publication::Publication,
        locks: &mut ImageMaintenanceLocks,
        service: &ImageServiceMaintenance,
    ) -> Result<()> {
        self.assert_before(owner)?;
        publication::fence(owner, locks, service)?;
        history.assert_history_bound(owner)?;
        self.guard(owner)?;
        self.original_current(false)?;
        self.history = Some(history.history_path().to_owned());
        self.phase = Phase::MoveAttempted;
        native::archive_uninstalled_pool_pending(
            self.parent.as_ref().expect("same pending directory"),
            history.history_fd(),
        )?;
        self.original_current(true)?;
        self.parent
            .as_ref()
            .expect("original directory")
            .sync_all()?;
        history.history_fd().sync_all()?;
        self.write_receipt(owner, history)?;
        self.phase = Phase::Archived;
        publication::fence(owner, locks, service)?;
        self.assert_after(owner, history)
    }
    fn write_receipt(
        &mut self,
        owner: &NominationOwner,
        history: &publication::Publication,
    ) -> Result<()> {
        self.receipt = Some(native::create_policy_temporary(
            history.history_fd(),
            OsStr::new("pending-negative.json"),
        )?);
        let raw=serde_json::to_vec(&serde_json::json!({"version":1,"purpose":"uninstalled-pool-pending-archived-unknown-v1",
            "operationId":self.intent.as_ref().expect("same original").operation_id().as_str(),
            "pendingSHA256":self.expected.as_str(),"nominationDigest":owner.request.as_ref().expect("same request").digest().as_str(),
            "priorOutcome":"unconfirmed","activationAuthorized":false,"startsAuthorized":false}))
            .map_err(|_|PoolNominationError::Refused("POOL_PENDING_RECEIPT"))?;
        let receipt = self.receipt.as_mut().expect("same writer");
        receipt.write_all(&raw)?;
        receipt.sync_all()?;
        let info = receipt.metadata()?;
        private_file(&info, 1)?;
        self.receipt_stamp = Some(native::PrivateFileStamp::of(&info));
        history.history_fd().sync_all()?;
        Ok(())
    }
    pub(super) fn assert_after(
        &self,
        owner: &NominationOwner,
        history: &publication::Publication,
    ) -> Result<()> {
        need(
            self.phase == Phase::Archived,
            "POOL_PENDING_ARCHIVE_UNCONFIRMED",
        )?;
        self.guard(owner)?;
        history.assert_history_bound(owner)?;
        self.original_current(true)?;
        match fs::symlink_metadata(&self.path) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(e) => return Err(e.into()),
            Ok(_) => return Err(PoolNominationError::Refused("POOL_PENDING_RECREATED")),
        }
        let info = fs::symlink_metadata(history.history_path().join("pending-negative.json"))?;
        need(
            self.receipt_stamp.as_ref() == Some(&native::PrivateFileStamp::of(&info)),
            "POOL_PENDING_RECEIPT_CHANGED",
        )?;
        if let Some(file) = &self.receipt {
            need(
                native::PrivateFileStamp::of(&file.metadata()?)
                    == native::PrivateFileStamp::of(&info),
                "POOL_PENDING_RECEIPT_CHANGED",
            )?;
        }
        Ok(())
    }
    pub(super) fn close(&mut self) -> Result<()> {
        if self.closure == Closure::Closed {
            return Ok(());
        }
        need(self.closure == Closure::Open, "POOL_PENDING_CLOSE_UNKNOWN")?;
        self.closure = Closure::Closing;
        let mut result = Ok(());
        for file in [&mut self.receipt, &mut self.original, &mut self.parent] {
            result = finalized(
                result,
                file.take()
                    .map_or(Ok(()), |file| native::close(file).map_err(Into::into)),
            );
        }
        result = finalized(
            result,
            self.admission.as_mut().map_or(Ok(()), |lock| {
                lock.close().map_err(PoolNominationError::from)
            }),
        );
        self.closure = if result.is_err() {
            Closure::Unknown
        } else {
            Closure::Closed
        };
        result
    }
}
