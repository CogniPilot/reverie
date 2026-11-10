//! A stopped, failed installation is retained negative evidence, never a
//! reconstructed activation/close receipt for the original B operation.
use super::*;
use crate::captured_client::{CapturedCall, CapturedOutput, Policy};
use reverie_core::ids::ContainerId;
use std::{ffi::OsString, time::Duration};
mod namespace;
mod observe;
mod publish;

pub(in crate::worker_pool::installation_request::nomination) struct Retirement {
    id: Option<ContainerId>,
    birth: Option<String>,
    original: Option<Vec<u8>>,
    retired_name: Option<String>,
    retired: bool,
    attempted: bool,
    pending: Option<CapturedCall>,
    logs: Option<CapturedOutput>,
    rename_output: Option<CapturedOutput>,
    namespace: namespace::Namespace,
    immutable: ImmutableInputObserver,
    inputs_raw: Option<ObservedImmutableInput>,
    inputs: Option<PoolImageInputsData>,
    receipt: Option<File>,
    receipt_stamp: Option<native::PrivateFileStamp>,
    receipt_path: Option<PathBuf>,
}
impl Retirement {
    fn empty() -> Self {
        Self {
            id: None,
            birth: None,
            original: None,
            retired_name: None,
            retired: false,
            attempted: false,
            pending: None,
            logs: None,
            rename_output: None,
            namespace: Default::default(),
            immutable: Default::default(),
            inputs_raw: None,
            inputs: None,
            receipt: None,
            receipt_stamp: None,
            receipt_path: None,
        }
    }
    fn call(&mut self, owner: &NominationOwner, args: Vec<OsString>) -> Result<CapturedOutput> {
        need(self.pending.is_none(), "POOL_RETIRE_NATIVE_RETAINED")?;
        let end = owner
            .runtime
            .stop_deadline()
            .map_or(owner.end, |s| s.min(owner.end));
        match owner.runtime.installed_engine().engine.client.run_scoped(
            args,
            end,
            &owner.runtime.cancellation(),
            Policy {
                maximum: Duration::from_secs(20),
                maximum_output: 65536,
                successful_exit: true,
            },
        ) {
            Ok(output) => Ok(output),
            Err(failure) => {
                self.pending = failure.call;
                Err(crate::engine_metadata::EngineError::from(failure.error).into())
            }
        }
    }
    pub(super) fn close(&mut self, runtime: &WorkerRuntime, end: Instant) -> Result<()> {
        let end = runtime.stop_deadline().map_or(end, |stop| end.min(stop));
        let pending = self.pending.as_ref().map_or(Ok(()), |call| {
            runtime
                .installed_engine()
                .engine
                .client
                .settle_call(call, end)
                .map_err(|e| crate::engine_metadata::EngineError::from(e).into())
        });
        let receipt = self
            .receipt
            .take()
            .map_or(Ok(()), |f| native::close(f).map_err(Into::into));
        finalized(finalized(pending, receipt), self.namespace.close())
    }
    pub(super) fn assert_metadata(&self) -> Result<()> {
        self.immutable.assert_finalized()?;
        self.namespace.assert_current()?;
        if let Some(stamp) = &self.receipt_stamp {
            need(
                self.receipt_path.as_ref().is_some_and(|p| {
                    fs::symlink_metadata(p)
                        .is_ok_and(|m| native::PrivateFileStamp::of(&m) == *stamp)
                }),
                "POOL_RETIRE_RECEIPT_CHANGED",
            )?;
        }
        Ok(())
    }
}

/// Explicit OS-owner failed-installation retirement. No caller-selected
/// container, executable, policy, image or evidence path is accepted.
pub fn retire_failed_os_pool_installation(
    source: Option<&Path>,
    config: &EffectiveWorkerConfig,
    expected: &JournalDigest,
    runtime: WorkerRuntime,
    end: Instant,
) -> std::result::Result<PoolNominationPublished, Box<PoolNominationRevisionFailure>> {
    finish_revision(Box::new(RevisionOwner {
        nominal: Box::new(NominationOwner::capture(
            source,
            config,
            Path::new(""),
            runtime,
            end,
            InputPurpose::FailedInstallation,
        )),
        expected: expected.clone(),
        default: 0,
        overrides: Vec::new(),
        next: None,
        stopped: None,
        service: None,
        service_origin: None,
        closed_service: None,
        service_failure: None,
        locks: None,
        closed_locks: None,
        lock_failure: None,
        publication: None,
        attempted: false,
        retirement: Some(Retirement::empty()),
        rebase_website: false,
    }))
}
