//! One service-captured worker lifetime and its immutable configuration identity.
//! Neither checked base data nor this wrapper is owner authorization or a
//! laptop start grant. Named effects require their real resource/phase owners.
use crate::worker_nix::{NixError, Workflows};
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
    nix: Workflows,
    laptop: crate::worker_laptop::Workflows,
}
/// Read-only view of the SAME installed first-stop producer. This contains no
/// setter, engine command, alternate clock, or resource/effect permission.
#[derive(Clone)]
pub struct WorkerStopBudget(Arc<InstalledWorkerEngine>);
impl WorkerStopBudget {
    pub fn deadline(&self) -> Option<Instant> {
        self.0.stop_deadline()
    }
    pub fn same_origin(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }
    pub fn same_runtime(&self, runtime: &WorkerRuntime) -> bool {
        Arc::ptr_eq(&self.0, &runtime.engine)
    }
}
#[derive(Debug)]
pub enum RuntimeError {
    Engine(EngineError),
    Nix(NixError),
    Laptop(crate::worker_laptop::LaptopError),
    Finalization {
        primary: Box<Self>,
        secondary: Box<Self>,
    },
}
impl std::fmt::Display for RuntimeError {
    fn fmt(&self, output: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Engine(error) => error.fmt(output),
            Self::Nix(error) => error.fmt(output),
            Self::Laptop(error) => error.fmt(output),
            Self::Finalization { primary, secondary } => {
                write!(output, "{primary}; additional cleanup: {secondary}")
            }
        }
    }
}
impl std::error::Error for RuntimeError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Engine(error) => Some(error),
            Self::Nix(error) => Some(error),
            Self::Laptop(error) => Some(error),
            Self::Finalization { primary, .. } => Some(primary.as_ref()),
        }
    }
}
impl WorkerRuntime {
    pub fn new(engine: InstalledWorkerEngine, base: &WorkerBase) -> Self {
        Self {
            engine: Arc::new(engine),
            identity: WorkerServiceIdentity::capture(base),
            nix: Workflows::new(base.connection_limit()),
            laptop: crate::worker_laptop::Workflows::new(base.connection_limit()),
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
    pub fn stop_budget(&self) -> WorkerStopBudget {
        WorkerStopBudget(self.engine.clone())
    }
    pub fn connection_limit(&self) -> usize {
        self.worker_identity().connection_limit()
    }
    pub fn settle_owned(&self, deadline: Instant) -> Result<(), RuntimeError> {
        let client = self
            .installed_engine()
            .settle_owned(deadline)
            .map_err(RuntimeError::Engine);
        let records = self.nix.settle(self, deadline).map_err(RuntimeError::Nix);
        let laptop = self
            .laptop
            .settle(self, deadline)
            .map_err(RuntimeError::Laptop);
        let resources = match (records, laptop) {
            (Ok(()), Ok(())) => Ok(()),
            (Err(error), Ok(())) | (Ok(()), Err(error)) => Err(error),
            (Err(primary), Err(secondary)) => Err(RuntimeError::Finalization {
                primary: Box::new(primary),
                secondary: Box::new(secondary),
            }),
        };
        match (resources, client) {
            (Ok(()), Ok(())) => Ok(()),
            (Err(error), Ok(())) | (Ok(()), Err(error)) => Err(error),
            (Err(primary), Err(secondary)) => Err(RuntimeError::Finalization {
                primary: Box::new(primary),
                secondary: Box::new(secondary),
            }),
        }
    }
    /// Request the first stop, settle all actual retained records, then seal the SAME
    /// client. Unconfirmed records retain all resources and prevent sealing.
    /// Returned storage owners remain App's duty; this is no writer-release ACK.
    pub fn close(&self, deadline: Instant) -> Result<(), RuntimeError> {
        let deadline = deadline.min(self.request_stop());
        // A retained helper must not hide a different actual client job.
        // Settle native work without sealing cleanup admission, then attempt
        // every retained record. Seal only after both owners confirm cleanup.
        self.settle_owned(deadline)?;
        self.installed_engine()
            .close(deadline)
            .map_err(RuntimeError::Engine)
    }
    pub(crate) fn installed_engine(&self) -> &Arc<InstalledWorkerEngine> {
        &self.engine
    }
    pub(crate) fn worker_identity(&self) -> &WorkerServiceIdentity {
        &self.identity
    }
    pub(crate) fn nix_workflows(&self) -> &Workflows {
        &self.nix
    }
    pub(crate) fn laptop_workflows(&self) -> &crate::worker_laptop::Workflows {
        &self.laptop
    }
}
