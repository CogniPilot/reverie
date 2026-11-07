//! Actual connection seats, shared with its owned native work after an HTTP
//! future is cancelled. This is resource custody, never a session/grant token.
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use tokio::sync::OwnedSemaphorePermit;
pub(super) struct RequestLifetime {
    _local: OwnedSemaphorePermit,
    _global: OwnedSemaphorePermit,
    live: Arc<AtomicUsize>,
}
impl RequestLifetime {
    pub(super) fn new(
        local: OwnedSemaphorePermit,
        global: OwnedSemaphorePermit,
        live: Arc<AtomicUsize>,
    ) -> Arc<Self> {
        live.fetch_add(1, Ordering::AcqRel);
        Arc::new(Self {
            _local: local,
            _global: global,
            live,
        })
    }
}
impl Drop for RequestLifetime {
    fn drop(&mut self) {
        self.live.fetch_sub(1, Ordering::AcqRel);
    }
}
