//! The actual original-source owner consumes one existing protected intent.
//! No path/CID/receipt or standalone read-side preparation can mint this join.
use super::*;
use crate::installing_broker::source::RegisteredSource;
use reverie_contracts::{
    reservation_baseline::SourceStopIntentRecord, worker_config, worker_source_stop::SourceStopName,
};
#[derive(Clone, Copy, Eq, PartialEq)]
pub(super) enum SourceStopPhase {
    Idle,
    Attempted,
    Invoked,
    Released,
    Failed,
}
pub struct SourceStopFacts {
    operation: JournalId,
}
impl SourceStopFacts {
    pub fn operation_id(&self) -> &JournalId {
        &self.operation
    }
    pub fn state(&self) -> &'static str {
        "SOURCE_RELEASED_TARGET_NOT_CREATED"
    }
    pub fn capacity_retained(&self) -> bool {
        true
    }
    pub fn retry_allowed(&self) -> bool {
        false
    }
    pub fn verified(&self) -> bool {
        false
    }
}
fn resource(error: crate::installing_broker::StorageWorkflowError) -> GateError {
    GateError::OriginalSource(Box::new(error))
}
impl RetainedPreparation {
    /// Same retained known source-release outcome only. A new launch must
    /// still reobserve native liveness/membership under its actual admission.
    pub(crate) fn assert_original_source_released(
        &self,
        intent: &ProtectedStartIntent,
        released: &SourceStopFacts,
    ) -> Result<()> {
        need(
            self.source_stop_phase == SourceStopPhase::Released
                && self
                    .start_owner
                    .as_ref()
                    .is_some_and(|own| own.same_intent(intent))
                && released.operation_id() == self.operation_id()
                && intent.operation_id() == self.operation_id()
                && self.live.load(std::sync::atomic::Ordering::Acquire)
                && self.journal_available(),
            "RESOURCE_NATIVE_SOURCE_RELEASE_REQUIRED",
        )
    }
    /// Actual same-claim, source-resource and one-attempt sequence. This is an
    /// installing primitive, not owner/API authentication or a target start.
    pub fn stop_original_source(
        &mut self,
        intent: &ProtectedStartIntent,
    ) -> Result<SourceStopFacts> {
        need(
            self.source_stop_phase == SourceStopPhase::Idle
                && self
                    .start_owner
                    .as_ref()
                    .is_some_and(|held| held.same_intent(intent)),
            "RESOURCE_NATIVE_SOURCE_STOP_ALREADY_ATTEMPTED",
        )?;
        let source = self
            .original_source
            .as_ref()
            .ok_or(GateError::Refused(
                "RESOURCE_ORIGINAL_SOURCE_OWNER_REQUIRED",
            ))?
            .clone();
        source.assert_claim(self).map_err(resource)?;
        match self.stop_source_attempt(&source, intent) {
            Ok(()) => {
                self.source_stop_phase = SourceStopPhase::Released;
                Ok(SourceStopFacts {
                    operation: self.operation_id().clone(),
                })
            }
            Err(error) => {
                self.source_stop_phase = SourceStopPhase::Failed;
                Err(GateError::NativeSourceStopUncertain {
                    cause: Box::new(finalized::<()>(Err(error), self.close_owned()).unwrap_err()),
                })
            }
        }
    }
    fn stop_source_attempt(
        &mut self,
        source: &RegisteredSource,
        intent: &ProtectedStartIntent,
    ) -> Result<()> {
        let gate = self.gate.clone();
        let admission = self.admit_preparation()?;
        let body = (|| {
            let state = self.qualify_intent(intent, true)?;
            self.source_stop_phase = SourceStopPhase::Attempted;
            let receipt = SourceStopIntentRecord::from_observed_data(
                self.view.record(),
                self.original_baseline(),
            )?;
            reservation_control::publish_source_stop_intent(gate.config()?.as_ref(), &receipt)?;
            if state.source_running() {
                // Original allow_source_stop/check_stop performs a SECOND full
                // qualification AFTER attempt publication, before invocation.
                self.qualify_intent(intent, true)?;
                self.source_stop_phase = SourceStopPhase::Invoked;
                self.invoke_original_stop(source)?;
            }
            self.qualify_intent(intent, false)?;
            let end = gate
                .held(None)?
                .deadline
                .lock()
                .map_err(|_| GateError::Refused("RESERVATION_ADMISSION_UNAVAILABLE"))?
                .unwrap_or_else(|| Instant::now() + std::time::Duration::from_secs(20));
            source.release_original_resource(end).map_err(resource)
        })();
        match body {
            Ok(()) => {
                admission.inspect_native_start(self, intent)?;
                source.finish_original_release().map_err(resource)
            }
            Err(error) => admission.conclude(Err(error)),
        }
    }
    fn invoke_original_stop(&self, source: &RegisteredSource) -> Result<()> {
        let config = self.gate.config()?;
        let snapshot = self.gate.installed.snapshot()?;
        let name =
            SourceStopName::from_baseline(snapshot.envelope().base(), self.original_baseline())
                .map_err(GateError::SourceStopData)?;
        let deadline = *self
            .gate
            .held(None)?
            .deadline
            .lock()
            .map_err(|_| GateError::Refused("RESERVATION_ADMISSION_UNAVAILABLE"))?;
        let session = source
            .inspect_original_stop(name, config.configuration(), deadline)
            .map_err(resource)?;
        // Keep this actual existing resolver at its original late phase, after
        // inspect+header checks and before strict State/PID/process checks.
        let policy = match crate::resource_staging::effective_config(
            self.gate.config()?.configuration().clone(),
            &session,
        ) {
            Ok(effective) => worker_config::policy_digest(&effective),
            Err(error) => {
                return finalized(
                    Err(error.into()),
                    source.refuse_original_policy().map_err(resource),
                );
            }
        };
        source.stop_original_after_policy(&policy).map_err(resource)
    }
}
