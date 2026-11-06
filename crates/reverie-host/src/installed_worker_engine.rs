//! One genuinely service-captured engine context for the installing lifecycle.
//! Readonly handles clone the SAME pending/cleanup/close fence. This bootstrap
//! object is neither API authorization nor a permission to start a laptop;
//! named effects still require their actual owned-resource/phase producers.
use crate::engine_metadata::{CancellationToken, EngineBootstrap, EngineError, ReadonlyEngine};
use std::time::Instant;
pub struct InstalledWorkerEngine {
    pub(crate) engine: ReadonlyEngine,
    cancellation: CancellationToken,
}
impl InstalledWorkerEngine {
    pub fn new(bootstrap: EngineBootstrap) -> Self {
        Self {
            engine: ReadonlyEngine::new(bootstrap),
            cancellation: CancellationToken::new(),
        }
    }
    pub fn readonly(&self) -> ReadonlyEngine {
        self.engine.clone()
    }
    pub fn cancellation(&self) -> CancellationToken {
        self.cancellation.clone()
    }
    pub fn settle_owned(&self, deadline: Instant) -> Result<(), EngineError> {
        self.engine.settle_owned(deadline)
    }
    /// Seal all clones before checking actual owned settlement. A failed close
    /// stays unconfirmed; later settlement cannot reopen or forgive that call.
    pub fn close(&self, deadline: Instant) -> Result<(), EngineError> {
        self.cancellation.cancel();
        self.engine.close(deadline)
    }
}
