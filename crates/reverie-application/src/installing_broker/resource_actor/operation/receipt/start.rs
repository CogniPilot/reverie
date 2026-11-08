//! A real source-start preparation, produced only by the original committed Q
//! owner and actual STARTING/source-stop methods. No parsed result mints it.
use super::*;
use crate::reservation_gate::{ProtectedStartIntent, SourceStopFacts};

struct StartAttempt<'a> {
    operation: CommittedRamOperation<'a>,
    intent: Option<ProtectedStartIntent>,
    released: Option<SourceStopFacts>,
}
impl StartAttempt<'_> {
    fn begin(&mut self) -> Result<()> {
        let owner = self.operation.owner_mut();
        owner.auth.receive_continuation(
            owner.claim.operation_id(),
            ResourceContinuationVerb::SourceStop,
        )?;
        self.operation.assert_current()?;
        let owner = self.operation.owner_mut();
        let result = owner.claim.begin_native_start().map_err(Into::into);
        self.intent = Some(owner.auth.website.frame.retain_stateless_result(result)?);
        Ok(())
    }
    fn release_source(&mut self) -> Result<()> {
        self.operation.assert_current()?;
        let owner = self.operation.owner_mut();
        let result = owner
            .claim
            .stop_original_source(
                self.intent
                    .as_ref()
                    .expect("actual STARTING intent retained"),
            )
            .map_err(Into::into);
        self.released = Some(owner.auth.website.frame.retain_stateless_result(result)?);
        self.operation.assert_current()
    }
}
/// Owns known STARTING and source-release outcomes. This is not an allocation,
/// new L peer/command qualification, pool/member proof or runtime readiness.
#[must_use = "retain the original whole Q owner through protected launch routing"]
pub struct PreparedResourceStart<'a> {
    operation: CommittedRamOperation<'a>,
    intent: ProtectedStartIntent,
    released: SourceStopFacts,
    command_attempted: bool,
}
struct FailedStart<'a> {
    attempt: StartAttempt<'a>,
    cause: ResourceActorError,
}
#[must_use = "failure retains original Q/claim/receipt and every attempted start/stop owner"]
pub struct ResourceStartFailure<'a> {
    owner: Option<Box<FailedStart<'a>>>,
}
impl<'a> CommittedRamOperation<'a> {
    pub fn prepare_resource_start(
        self,
    ) -> std::result::Result<PreparedResourceStart<'a>, Box<ResourceStartFailure<'a>>> {
        let mut attempt = StartAttempt {
            operation: self,
            intent: None,
            released: None,
        };
        let result = attempt.begin().and_then(|()| attempt.release_source());
        if let Err(cause) = result {
            attempt.operation.owner_mut().auth.website.frame.failed = true;
            return Err(Box::new(ResourceStartFailure {
                owner: Some(Box::new(FailedStart { attempt, cause })),
            }));
        }
        let StartAttempt {
            operation,
            intent,
            released,
        } = attempt;
        Ok(PreparedResourceStart {
            operation,
            intent: intent.expect("actual STARTING outcome"),
            released: released.expect("actual source-release outcome"),
            command_attempted: false,
        })
    }
}
impl PreparedResourceStart<'_> {
    /// Receive the actual start request on this original Q thread. This does
    /// not qualify an L peer, enter allocation or grant pool membership.
    pub fn receive_start_continuation(&mut self) -> Result<()> {
        let owner = self.operation.owner_mut();
        owner
            .auth
            .receive_continuation(owner.claim.operation_id(), ResourceContinuationVerb::Start)
    }
    /// The surrounding launch owner must retain the original Held L and its
    /// native pin before this one-shot same-Q command exchange. Selection here
    /// is derived only from that actual held request, not caller command DATA.
    pub fn assert_launch_command(
        &mut self,
        held: &reverie_host::worker_reports::HeldProtectedWorkerLaunch,
    ) -> Result<()> {
        let result = (|| {
            need(
                !self.command_attempted,
                "RESOURCE_RAM_COMMAND_ALREADY_ATTEMPTED",
            )?;
            self.command_attempted = true;
            self.assert_release()?;
            let incoming = held.incoming();
            let selected = RamLaunchCommandData::from_observed_data(
                self.request(),
                incoming.reference(),
                incoming.connection().request(),
                incoming.request_digest(),
            )?;
            let owner = self.operation.owner_mut();
            need(
                incoming.reference().as_str() == owner.claim.operation_id().as_str(),
                "RESOURCE_RAM_LAUNCH_REFERENCE_CHANGED",
            )?;
            held.assert_current(&owner.auth.website.frame.broker.storage.runtime)?;
            owner.auth.assert_launch_command(&selected)?;
            held.assert_current(&owner.auth.website.frame.broker.storage.runtime)?;
            self.assert_live()
        })();
        self.operation.owner_mut().auth.website.frame.failed |= result.is_err();
        result
    }
    fn assert_release(&self) -> Result<()> {
        Ok(self
            .operation
            .owner()
            .claim
            .assert_original_source_released(&self.intent, &self.released)?)
    }
    pub fn request(&self) -> &ResourceOperationRequest {
        self.operation.request()
    }
    pub fn target_resources(&self) -> &reverie_core::resources::ResourcePolicy {
        self.operation.policy().target_resources()
    }
    pub fn assert_broker(&self, broker: &InstallingBroker) -> Result<()> {
        self.operation.owner().auth.assert_broker(broker)?;
        self.assert_release()
    }
    pub fn assert_current(&mut self) -> Result<()> {
        let result = self
            .operation
            .assert_current()
            .and_then(|()| self.assert_release());
        self.operation.owner_mut().auth.website.frame.failed |= result.is_err();
        result
    }
    pub fn assert_live(&mut self) -> Result<()> {
        let result = self
            .operation
            .assert_live()
            .and_then(|()| self.assert_release());
        self.operation.owner_mut().auth.website.frame.failed |= result.is_err();
        result
    }
    pub fn disconnect_for_worker(&mut self) -> Result<WorkerLaunchClose> {
        self.operation.disconnect_for_worker()
    }
}
impl ResourceStartFailure<'_> {
    fn owner(&self) -> &FailedStart<'_> {
        self.owner.as_deref().expect("whole failed start retained")
    }
    pub fn cause(&self) -> &ResourceActorError {
        &self.owner().cause
    }
    pub fn request(&self) -> &ResourceOperationRequest {
        self.owner().attempt.operation.request()
    }
    pub fn disconnect_for_worker(&mut self) -> Result<WorkerLaunchClose> {
        self.owner
            .as_deref_mut()
            .expect("whole failed start retained")
            .attempt
            .operation
            .disconnect_for_worker()
    }
}
impl Drop for ResourceStartFailure<'_> {
    fn drop(&mut self) {
        if let Some(owner) = self.owner.take() {
            std::mem::forget(owner);
        }
    }
}
impl std::fmt::Display for ResourceStartFailure<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.cause().fmt(f)
    }
}
impl std::fmt::Debug for ResourceStartFailure<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ResourceStartFailure")
            .field("cause", self.cause())
            .field("request", self.request().request_id())
            .finish_non_exhaustive()
    }
}
impl std::error::Error for ResourceStartFailure<'_> {}
