//! Fresh final named-laptop observation on the original closed viewer record.
//! Optional query failure is unknown until a complete successful census; the
//! result is read-side DATA, never a storage/global release permission.
use super::*;
use crate::captured_client::CapturedCall;
use reverie_contracts::worker_source_stop::{OrdinaryContainer, ordinary_container_absent};
use std::{ffi::OsString, time::Duration};

#[derive(Default)]
pub(super) struct StorageCheck {
    attempted: bool,
    current: Option<Arc<()>>,
    pending: Option<CapturedCall>,
    failure: Option<Arc<LaptopError>>,
}
/// Sealed to this exact one-shot native observation and resource acquisition.
pub struct ExistingStorageObservation {
    reference: ExistingReference,
    current: Arc<()>,
    live: bool,
}
impl ExistingStorageObservation {
    pub fn is_live(&self) -> bool {
        self.live
    }
    pub fn same_owner(&self, owner: &ExistingViewer) -> bool {
        self.reference.same_owner(&owner.reference)
    }
}
impl StorageCheck {
    pub(super) fn require_reclaimable(
        &self,
        owner: &ExistingViewer,
        observation: Option<&ExistingStorageObservation>,
    ) -> Result<()> {
        let valid = match (self.attempted, observation) {
            (false, None) => true,
            (true, Some(observation)) => {
                observation.same_owner(owner)
                    && self
                        .current
                        .as_ref()
                        .is_some_and(|current| Arc::ptr_eq(current, &observation.current))
            }
            _ => false,
        };
        need(
            valid && self.failure.is_none() && self.pending.is_none(),
            "WORKER_FINAL_STORAGE_UNCONFIRMED",
        )
    }
    pub(super) fn settle(&mut self, runtime: &WorkerRuntime, end: Instant) -> Result<()> {
        if let Some(call) = &self.pending {
            let end = runtime.stop_deadline().map_or(end, |stop| end.min(stop));
            runtime
                .installed_engine()
                .engine
                .client
                .settle_call(call, end)
                .map_err(|error| LaptopError::Engine(error.into()))?;
            self.pending = None;
        }
        Ok(())
    }
    fn call(
        &mut self,
        runtime: &WorkerRuntime,
        arguments: Vec<OsString>,
        required: bool,
    ) -> Result<crate::captured_client::CapturedOutput> {
        // Reuse the actual fixed cleanup call owner and its typed before-start
        // admission policy. This purpose alone selects the argv above/below.
        crate::worker_source_stop::captured_worker_cleanup(
            runtime.installed_engine(),
            Instant::now() + Duration::from_secs(20),
            &mut self.pending,
            arguments,
            required,
        )
        .map_err(|error| match error {
            crate::worker_source_stop::SourceStopError::Engine(error) => LaptopError::Engine(error),
            crate::worker_source_stop::SourceStopError::Refused(code) => LaptopError::Refused(code),
            error => LaptopError::OrdinaryStop(error),
        })
    }
}
impl WorkerRuntime {
    /// Read the checked name of this same resource for App stop admission.
    /// This DATA neither grants a stop nor selects another effect target.
    pub fn existing_viewer_stop_target(
        &self,
        existing: &ExistingViewer,
    ) -> Result<reverie_core::worker_laptop::WorkerContainerName> {
        self.laptop_workflows()
            .bound_existing(self, &existing.reference)?;
        let record = existing
            .reference
            .record
            .try_lock()
            .map_err(|_| LaptopError::Refused("WORKER_EXISTING_VIEWER_RETAINED"))?;
        let inputs = record
            .inputs
            .as_ref()
            .ok_or(LaptopError::Refused("WORKER_EXISTING_VIEWER_CONSUMED"))?;
        inputs
            .plan
            .assert_storage_owner(self, &inputs.storage)
            .map_err(LaptopError::Plan)?;
        Ok(
            reverie_core::worker_laptop::WorkerContainerName::from_launch_name_data(
                inputs.plan.arguments().worker_name(),
            ),
        )
    }
    /// Runs only after checked viewer closure, using the SAME original inputs.
    /// No caller-selected name, CID, lease, ready flag or native fact is accepted.
    pub fn observe_existing_final_storage(
        &self,
        existing: &ExistingViewer,
    ) -> Result<ExistingStorageObservation> {
        self.laptop_workflows()
            .bound_existing(self, &existing.reference)?;
        let mut record = existing
            .reference
            .record
            .try_lock()
            .map_err(|_| LaptopError::Refused("WORKER_EXISTING_VIEWER_RETAINED"))?;
        need(
            record.stage == Stage::Closed && !record.finalization.attempted,
            "WORKER_FINAL_STORAGE_PHASE",
        )?;
        record.finalization.attempted = true;
        let result = observe(self, &mut record);
        match result {
            Ok(live) => {
                let current = Arc::new(());
                record.finalization.current = Some(current.clone());
                Ok(ExistingStorageObservation {
                    reference: existing.reference.clone(),
                    current,
                    live,
                })
            }
            Err(error) => {
                let error = Arc::new(error);
                record.finalization.failure = Some(error.clone());
                Err(LaptopError::Recorded(error))
            }
        }
    }
}
fn observe(runtime: &WorkerRuntime, record: &mut ExistingRecord) -> Result<bool> {
    let inputs = record.inputs.as_ref().expect("closed original inputs");
    inputs
        .plan
        .assert_storage_owner(runtime, &inputs.storage)
        .map_err(LaptopError::Plan)?;
    inputs
        .inspected
        .assert_plan(runtime, &inputs.plan)
        .map_err(LaptopError::ExistingObservation)?;
    let name = inputs.plan.arguments().name().to_owned();
    let original = inputs
        .inspected
        .data()
        .canonical_id()
        .ok_or(LaptopError::Refused("WORKER_FINAL_STORAGE_IDENTITY"))?;
    let session = inputs.plan.session().clone();
    let output =
        record
            .finalization
            .call(runtime, vec!["inspect".into(), name.clone().into()], false)?;
    if output.succeeded {
        let row = OrdinaryContainer::decode(
            &output.stdout,
            &name,
            runtime.worker_identity().deployment(),
            &session,
        )
        .map_err(|error| {
            LaptopError::OrdinaryStop(crate::worker_source_stop::SourceStopError::Data(error))
        })?;
        need(
            row.id() == &original,
            "WORKER_FINAL_STORAGE_IDENTITY_CHANGED",
        )?;
        if row.running() {
            return Ok(true);
        }
        need(row.stopped(), "WORKER_FINAL_STORAGE_STATE_UNAVAILABLE")?;
        return Ok(false);
    }
    let census = record.finalization.call(
        runtime,
        [
            "ps",
            "--all",
            "--no-trunc",
            "--format",
            "{{.ID}} {{.Names}}",
        ]
        .into_iter()
        .map(OsString::from)
        .collect(),
        true,
    )?;
    let absent =
        ordinary_container_absent(&census.stdout, &name, Some(&original)).map_err(|error| {
            LaptopError::OrdinaryStop(crate::worker_source_stop::SourceStopError::Data(error))
        })?;
    need(absent, "WORKER_FINAL_STORAGE_STATE_UNAVAILABLE")?;
    Ok(false)
}
