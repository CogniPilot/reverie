//! Initial actor publication over the original source, R, service and facts
//! owners. Receipts describe checked files; they grant no installation consent.
use super::*;
use crate::{
    private_pending::PendingFile,
    reservation_control::AdmissionLock,
    resource_facts::{ActorSetupFacts, ActorSetupFactsError},
    worker_image::{ImageMaintenanceLocks, ImageRenameFence},
    worker_runtime::WorkerStopBudget,
    worker_service::ImageServiceMaintenance,
};
use reverie_contracts::{
    reservation_control::ControlBinding,
    resource_actor::{ActorSetupDataError, ActorSetupTransition},
};
use reverie_core::operations::{JournalDigest, JournalId};
use std::{cell::RefCell, os::unix::fs::MetadataExt, rc::Rc, sync::Arc, time::Instant};
mod error;
mod fence;
mod interface;
mod pending;
mod publication;
mod source;
mod terminal;
pub use error::ActorSetupControlError;
type SetupResult<T> = std::result::Result<T, Rc<ActorSetupControlError>>;
use error::Causes;
pub(super) use fence::ActorSetupRenameFence;

#[must_use = "retain the original actor setup attempt through checked release"]
pub struct ActorSetupControlFiles {
    owner: Option<Box<SetupState>>,
}
struct SetupState {
    files: GpuControlFiles,
    brand: Arc<()>,
    causes: Rc<RefCell<Causes>>,
    source: Option<GpuPrivateSnapshot>,
    raw: Option<Vec<u8>>,
    captured_source: Option<(GpuFileStamp, u32)>,
    captured_binding: Option<(GpuFileStamp, u32)>,
    binding: Option<GpuPrivateSnapshot>,
    groups: Option<(u32, u32)>,
    intent: Option<Arc<ActorSetupTransition>>,
    facts: Option<ActorSetupFacts>,
    parents: Option<Arc<GpuParentGuard>>,
    protected: Option<Arc<WorkerProtectedStores>>,
    pending_attempted: bool,
    publication_attempted: bool,
    components_closed: bool,
    released: bool,
}
#[must_use = "retain the original pending; only its writer can release it"]
pub struct ActorSetupPending {
    file: Option<PendingFile>,
    proof: Arc<PendingProof>,
}
struct PendingProof {
    brand: Arc<()>,
    intent: Arc<ActorSetupTransition>,
    operation: JournalId,
    preview: JournalDigest,
    facts_digest: JournalDigest,
    facts_raw: Vec<u8>,
    root: PathBuf,
    path: PathBuf,
    stamp: GpuFileStamp,
    end: Instant,
    stop: WorkerStopBudget,
}
/// Same original three checked publications, not global closure or permission.
pub struct ActorSetupTerminal {
    proof: Arc<PendingProof>,
    parents: Arc<GpuParentGuard>,
    protected: Arc<WorkerProtectedStores>,
    leaves: Vec<(PathBuf, GpuFileStamp, u32)>,
}
impl SetupState {
    fn live(&self) -> SetupResult<()> {
        let causes = self.causes.borrow();
        causes
            .primary
            .as_ref()
            .or(causes.cleanup.as_ref())
            .map_or(Ok(()), |e| Err(e.clone()))
    }
    fn host<T>(&self, result: Result<T>) -> SetupResult<T> {
        result.map_err(|e| self.causes.borrow_mut().host(e))
    }
    fn refuse(&self, code: &'static str) -> Rc<ActorSetupControlError> {
        self.causes
            .borrow_mut()
            .record(ActorSetupControlError::Refused(code))
    }
}
impl Drop for ActorSetupControlFiles {
    fn drop(&mut self) {
        if self.owner.as_ref().is_some_and(|o| {
            !o.released
                || o.causes.borrow().primary.is_some()
                || o.causes.borrow().cleanup.is_some()
        }) {
            std::mem::forget(self.owner.take());
        }
    }
}
impl Drop for ActorSetupPending {
    fn drop(&mut self) {
        if self.file.as_ref().is_some_and(|f| !f.confirmed()) {
            std::mem::forget((self.file.take(), self.proof.clone()));
        }
    }
}
