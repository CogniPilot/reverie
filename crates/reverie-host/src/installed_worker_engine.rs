//! One genuinely service-captured engine context for the installing lifecycle.
//! Readonly handles clone the SAME pending/cleanup/close fence. This bootstrap
//! object is neither API authorization nor a permission to start a laptop;
//! named effects still require their actual owned-resource/phase producers.
use crate::engine_metadata::{CancellationToken, EngineBootstrap, EngineError, ReadonlyEngine};
use std::{
    sync::{
        OnceLock,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
pub struct InstalledWorkerEngine {
    pub(crate) engine: ReadonlyEngine,
    cancellation: CancellationToken,
    first_stop: OnceLock<Instant>,
    broker_signals: OnceLock<()>,
    closed_confirmed: AtomicBool,
}
impl InstalledWorkerEngine {
    pub fn new(bootstrap: EngineBootstrap) -> Self {
        Self {
            engine: ReadonlyEngine::new(bootstrap),
            cancellation: CancellationToken::new(),
            first_stop: OnceLock::new(),
            broker_signals: OnceLock::new(),
            closed_confirmed: AtomicBool::new(false),
        }
    }
    pub fn readonly(&self) -> ReadonlyEngine {
        self.engine.clone()
    }
    pub fn cancellation(&self) -> CancellationToken {
        self.cancellation.clone()
    }
    /// The installing service's actual first-stop producer. Publish the captured
    /// start BEFORE launch cancellation; repeated/concurrent calls never grant
    /// another budget. This is shutdown state, not API or laptop authority.
    pub fn request_stop(&self) -> Instant {
        let first = *self.first_stop.get_or_init(Instant::now);
        self.cancellation.cancel();
        self.stop_deadline()
            .unwrap_or(first + Duration::from_secs(34))
    }
    pub fn stop_deadline(&self) -> Option<Instant> {
        let requested = self
            .first_stop
            .get()
            .map(|first| *first + Duration::from_secs(34));
        match (requested, self.cancellation.worker_signal_deadline()) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (Some(a), None) | (None, Some(a)) => Some(a),
            (None, None) => None,
        }
    }
    pub(crate) fn reserve_broker_signals(&self) -> bool {
        self.broker_signals.set(()).is_ok()
    }
    pub(crate) fn signal_restoration_ready(&self) -> bool {
        self.closed_confirmed.load(Ordering::Acquire)
    }
    pub fn settle_owned(&self, deadline: Instant) -> Result<(), EngineError> {
        self.engine.settle_owned(self.settlement_deadline(deadline))
    }
    fn settlement_deadline(&self, deadline: Instant) -> Instant {
        self.stop_deadline()
            .map_or(deadline, |stop| deadline.min(stop))
    }
    #[cfg(test)]
    pub(crate) fn expire_stop_for_owned_test(&self) {
        self.first_stop
            .set(Instant::now() - Duration::from_secs(35))
            .expect("fresh owned fixture");
        self.cancellation.cancel();
    }
    /// Seal all clones before checking actual owned settlement. A failed close
    /// stays unconfirmed; later settlement cannot reopen or forgive that call.
    pub fn close(&self, deadline: Instant) -> Result<(), EngineError> {
        self.request_stop();
        let result = self.engine.close(self.settlement_deadline(deadline));
        if result.is_ok() {
            self.closed_confirmed.store(true, Ordering::Release);
        }
        result
    }
}
