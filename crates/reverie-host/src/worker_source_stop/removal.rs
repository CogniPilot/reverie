//! A move-only old-target owner minted only by a confirmed stop extracting its
//! actual Box. It is not created from an inspection/process/status DTO.
use super::*;
use crate::worker_launch::ObservedCreatePlan;
use reverie_core::ids::{ContainerId, ProfileSessionId};
mod run;
enum Binding {
    Exact(SourceStopMetadata),
    Legacy,
}
#[derive(Clone, Copy, Eq, PartialEq)]
enum RemovalPhase {
    Held,
    Attempted,
    Confirmed,
    Failed,
}
#[must_use = "carry the actual stopped old target through the same Box-to-Nix transfer"]
pub struct StoppedLaptopRemoval {
    origin: Arc<InstalledWorkerEngine>,
    resource: Arc<()>,
    identity: Arc<()>,
    name: String,
    session: ProfileSessionId,
    container: Option<ContainerId>,
    binding: Binding,
    phase: RemovalPhase,
    failure: Option<Arc<SourceStopError>>,
}
impl StoppedLaptopRemoval {
    pub(super) fn exact(inner: &mut ExactStopAttempt) -> Self {
        assert!(inner.phase == Phase::Stopped);
        Self {
            origin: inner.origin.clone(),
            resource: inner
                .storage
                .as_ref()
                .expect("same stopped Box")
                .owner_identity()
                .clone(),
            identity: Arc::new(()),
            name: inner.name.name().as_str().to_owned(),
            session: inner.name.session().clone(),
            container: Some(inner.name.container().clone()),
            binding: Binding::Exact(
                inner
                    .metadata
                    .take()
                    .expect("actual exact stopped metadata"),
            ),
            phase: RemovalPhase::Held,
            failure: None,
        }
    }
    pub(super) fn legacy(
        origin: Arc<InstalledWorkerEngine>,
        storage: &LaunchStorage,
        name: String,
        session: ProfileSessionId,
        container: Option<ContainerId>,
    ) -> Self {
        Self {
            origin,
            resource: storage.owner_identity().clone(),
            identity: Arc::new(()),
            name,
            session,
            container,
            binding: Binding::Legacy,
            phase: RemovalPhase::Held,
            failure: None,
        }
    }
    pub(crate) fn assert_binding(
        &self,
        runtime: &WorkerRuntime,
        storage: &LaunchStorage,
        plan: &ObservedCreatePlan,
    ) -> Result<()> {
        need(
            self.phase == RemovalPhase::Held,
            "WORKER_STOPPED_REMOVAL_ALREADY_ATTEMPTED",
        )?;
        need(
            Arc::ptr_eq(&self.origin, runtime.installed_engine())
                && Arc::ptr_eq(&self.resource, storage.owner_identity())
                && &self.session == plan.session()
                && self.name == plan.arguments().name(),
            "WORKER_STOPPED_REMOVAL_ORIGIN",
        )?;
        // Preserve the original one-time plan. This neither reruns create_args
        // nor substitutes an observation brand for current actual custody.
        plan.assert_storage_owner(runtime, storage)
            .map_err(SourceStopError::Plan)
    }
    pub(crate) fn identity(&self) -> &Arc<()> {
        &self.identity
    }
    pub(crate) fn attempt(
        &mut self,
        runtime: &WorkerRuntime,
        pending: &mut Option<CapturedCall>,
        deadline: Option<Instant>,
    ) -> Result<()> {
        need(
            self.phase == RemovalPhase::Held,
            "WORKER_STOPPED_REMOVAL_ALREADY_ATTEMPTED",
        )?;
        need(
            Arc::ptr_eq(&self.origin, runtime.installed_engine()),
            "WORKER_STOPPED_REMOVAL_ORIGIN",
        )?;
        self.phase = RemovalPhase::Attempted;
        match self.body(runtime, pending, deadline) {
            Ok(()) => Ok(()),
            Err(error) => {
                self.phase = RemovalPhase::Failed;
                let error = Arc::new(error);
                self.failure = Some(error.clone());
                Err(SourceStopError::Recorded(error))
            }
        }
    }
    pub(crate) fn confirmed(&mut self) {
        assert!(self.phase == RemovalPhase::Attempted);
        self.phase = RemovalPhase::Confirmed;
    }
    pub(crate) fn rejected(&mut self) {
        self.phase = RemovalPhase::Failed;
    }
}
