//! Paired publication attached to the original denial owner. These brands
//! prove checked file publication only, never fleet closure or authorization.
use super::*;
use crate::gpu_access::{
    GpuControlFiles, GpuFileStamp, GpuParentGuard, GpuPrivateSnapshot, WorkerProtectedStores,
};
use crate::{
    resource_facts::{ActorRebindPlan, ActorRebound},
    worker_runtime::WorkerStopBudget,
};
use reverie_contracts::worker_pool::WorkerPoolConfigurationTransition;
use std::{
    path::{Path, PathBuf},
    time::Instant,
};
mod error;
mod fence;
mod member;
mod prepared;
mod terminal;
pub(super) use error::FailureLedger;
pub use error::{PoolPublicationCause, PoolPublicationFailure};
pub(crate) use fence::PoolRenameFence;
pub use member::{MemberPolicyCancellation, MemberPolicyPending, MemberPolicyPublication};

#[must_use = "only the same pending owner can consume this preparation brand"]
pub struct PoolPublicationPrepared {
    ledger: Arc<FailureLedger>,
}
/// Both strict CAS calls and their native finalizers completed. DATA only.
#[must_use = "retain the original pending owner through application publication and closure"]
pub struct PoolPublication {
    ledger: Arc<FailureLedger>,
}
/// Exact after-file and original pending proof. No admission-close receipt.
pub struct PoolTerminal {
    ledger: Arc<FailureLedger>,
    proof: Arc<PendingProof>,
    snapshot: Arc<PublishedSnapshot>,
}
#[derive(Clone, Copy, Eq, PartialEq)]
enum Phase {
    Preparing,
    Prepared,
    Attempted,
    Published,
    Released,
}
pub(super) struct PublicationState {
    source: PathBuf,
    files: GpuControlFiles,
    transition: Arc<WorkerPoolConfigurationTransition>,
    actor: ActorRebindPlan,
    actor_after: Option<ActorRebound>,
    configuration: Option<GpuPrivateSnapshot>,
    binding: Option<GpuPrivateSnapshot>,
    groups: Option<(u32, u32)>,
    parents: Option<Arc<GpuParentGuard>>,
    protected: Option<Arc<ProtectedStores>>,
    source_after: Option<GpuFileStamp>,
    binding_after: Option<GpuFileStamp>,
    published: Option<Arc<PublishedSnapshot>>,
    phase: Phase,
    end: Instant,
    stop: WorkerStopBudget,
}
struct ProtectedStores(WorkerProtectedStores);
struct PublishedSnapshot {
    leaves: Vec<(PathBuf, GpuFileStamp, u32)>,
    parents: Arc<GpuParentGuard>,
    protected: Arc<ProtectedStores>,
    end: Instant,
    stop: WorkerStopBudget,
    actor: ActorRebound,
}
impl PoolTransitionPending {
    /// The application supplies its selected source, actual admission, and
    /// pure candidate only after its separate authority/currentness checks.
    /// Store this SAME pending owner before entering any fallible read.
    pub fn prepare_publication(
        &mut self,
        source: &Path,
        transition: Arc<WorkerPoolConfigurationTransition>,
        actor: ActorRebindPlan,
        admission: &AdmissionLock,
        stop: &WorkerStopBudget,
        end: Instant,
    ) -> Result<PoolPublicationPrepared> {
        need(
            transition.member_edit().is_none(),
            "POOL_FLEET_CONFIGURATION_REQUIRED",
        )?;
        self.prepare_selected_publication(source, transition, actor, admission, stop, end)
    }

    fn prepare_selected_publication(
        &mut self,
        source: &Path,
        transition: Arc<WorkerPoolConfigurationTransition>,
        actor: ActorRebindPlan,
        admission: &AdmissionLock,
        stop: &WorkerStopBudget,
        end: Instant,
    ) -> Result<PoolPublicationPrepared> {
        let owner = self.owner_mut();
        owner.ledger.live()?;
        let result = (|| {
            need(
                owner.publication.is_none(),
                "POOL_PUBLICATION_ALREADY_PREPARED",
            )?;
            owner.publication = Some(PublicationState::capture(
                source, transition, actor, stop, end,
            ));
            owner
                .publication
                .as_mut()
                .expect("stored original attempt")
                .prepare(&owner.proof, &owner.file, admission)?;
            Ok(PoolPublicationPrepared {
                ledger: owner.ledger.clone(),
            })
        })();
        owner.ledger.finish(result)
    }
    /// Exactly one paired attempt. A partial CAS is retained, never rolled back.
    pub fn publish_prepared(
        &mut self,
        prepared: &PoolPublicationPrepared,
        admission: &AdmissionLock,
    ) -> Result<PoolPublication> {
        let owner = self.owner_mut();
        owner.ledger.live()?;
        let result = (|| {
            need(
                Arc::ptr_eq(&prepared.ledger, &owner.ledger),
                "POOL_PUBLICATION_FOREIGN",
            )?;
            owner
                .publication
                .as_mut()
                .ok_or(ControlHostError::Refused("POOL_PUBLICATION_PHASE"))?
                .publish(&owner.proof, &owner.file, admission)?;
            Ok(PoolPublication {
                ledger: owner.ledger.clone(),
            })
        })();
        owner.ledger.finish(result)
    }
    /// Candidate DATA remains available only through the original live owner.
    pub fn publication_transition(
        &self,
        publication: &PoolPublication,
    ) -> Result<&WorkerPoolConfigurationTransition> {
        let owner = self.owner();
        owner.ledger.live()?;
        let result = (|| {
            need(
                Arc::ptr_eq(&publication.ledger, &owner.ledger),
                "POOL_PUBLICATION_FOREIGN",
            )?;
            let state = owner
                .publication
                .as_ref()
                .ok_or(ControlHostError::Refused("POOL_PUBLICATION_PHASE"))?;
            need(state.phase == Phase::Published, "POOL_PUBLICATION_PHASE")?;
            Ok(state.transition.as_ref())
        })();
        owner.ledger.finish(result)
    }
    pub fn publication_actor_rebind(&self, publication: &PoolPublication) -> Result<&ActorRebound> {
        let owner = self.owner();
        owner.ledger.live()?;
        let result = (|| {
            need(
                Arc::ptr_eq(&publication.ledger, &owner.ledger),
                "POOL_PUBLICATION_FOREIGN",
            )?;
            let state = owner
                .publication
                .as_ref()
                .ok_or(ControlHostError::Refused("POOL_PUBLICATION_PHASE"))?;
            need(state.phase == Phase::Published, "POOL_PUBLICATION_PHASE")?;
            state
                .actor_after
                .as_ref()
                .ok_or(ControlHostError::Refused("POOL_PUBLICATION_PHASE"))
        })();
        owner.ledger.finish(result)
    }
}
impl PublicationState {
    fn capture(
        source: &Path,
        transition: Arc<WorkerPoolConfigurationTransition>,
        actor: ActorRebindPlan,
        stop: &WorkerStopBudget,
        end: Instant,
    ) -> Self {
        let end = end.min(actor.original_deadline());
        Self {
            source: source.to_owned(),
            files: GpuControlFiles::capture(source, transition.before()),
            transition,
            actor,
            actor_after: None,
            configuration: None,
            binding: None,
            groups: None,
            parents: None,
            protected: None,
            source_after: None,
            binding_after: None,
            published: None,
            phase: Phase::Preparing,
            end,
            stop: stop.clone(),
        }
    }
    fn deadline(&self) -> Instant {
        self.stop
            .deadline()
            .map_or(self.end, |stop| self.end.min(stop))
    }
    fn binding_path(proof: &PendingProof) -> Result<PathBuf> {
        Ok(native::python_path(
            &proof.config.control_paths()?.binding().codepoints(),
        )?)
    }
}
