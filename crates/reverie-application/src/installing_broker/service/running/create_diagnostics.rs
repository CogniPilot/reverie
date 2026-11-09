//! Local owner API only. No wire endpoint, native operation or raw-data log.
use super::*;
use reverie_host::worker_laptop::{LaptopCreateDiagnostic, LaptopError};

impl BrokerService {
    /// Historical outputs from the original service Runtime's retained create
    /// owners. This never reconciles a handler or changes its unknown outcome.
    /// The caller chooses whether to preserve private diagnostic bytes.
    pub fn completed_create_diagnostics(
        &self,
    ) -> Result<Vec<Arc<LaptopCreateDiagnostic>>, LaptopError> {
        self.startup
            .owner
            .broker
            .storage
            .runtime
            .completed_create_diagnostics()
    }
}
