//! One service-captured worker lifetime and its immutable configuration identity.
//! Neither checked base data nor this wrapper is owner authorization or a
//! laptop start grant. Named effects require their real resource/phase owners.
use crate::{
    engine_metadata::{CancellationToken, EngineError, ReadonlyEngine},
    installed_worker_engine::InstalledWorkerEngine,
};
use reverie_core::worker_schema::{WorkerBase, WorkerServiceIdentity};
use std::{sync::Arc, time::Instant};
#[cfg(test)]
mod tests;

/// Consumes one existing installed capture; it never creates a replacement
/// runner. Readonly handles share that exact pending/cleanup/close context.
pub struct WorkerRuntime {
    engine: Arc<InstalledWorkerEngine>,
    identity: WorkerServiceIdentity,
}
impl WorkerRuntime {
    pub fn new(engine: InstalledWorkerEngine, base: &WorkerBase) -> Self {
        Self {
            engine: Arc::new(engine),
            identity: WorkerServiceIdentity::capture(base),
        }
    }
    pub fn readonly(&self) -> ReadonlyEngine {
        self.installed_engine().readonly()
    }
    pub fn cancellation(&self) -> CancellationToken {
        self.installed_engine().cancellation()
    }
    pub fn request_stop(&self) -> Instant {
        self.installed_engine().request_stop()
    }
    pub fn stop_deadline(&self) -> Option<Instant> {
        self.installed_engine().stop_deadline()
    }
    pub fn connection_limit(&self) -> usize {
        self.worker_identity().connection_limit()
    }
    pub fn settle_owned(&self, deadline: Instant) -> Result<(), EngineError> {
        self.installed_engine().settle_owned(deadline)
    }
    /// Only the current readonly client lifetime is settled here. Before any
    /// effect is exposed its actual retained workflow must join this boundary;
    /// this method is not a laptop/container/writer-release acknowledgement.
    pub fn close(&self, deadline: Instant) -> Result<(), EngineError> {
        self.installed_engine().close(deadline)
    }
    pub(crate) fn installed_engine(&self) -> &Arc<InstalledWorkerEngine> {
        &self.engine
    }
    pub(crate) fn worker_identity(&self) -> &WorkerServiceIdentity {
        &self.identity
    }
}
