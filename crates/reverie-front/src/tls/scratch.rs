//! A generation-reserved parser workspace. Acquiring it never competes with
//! already-issued payload credits. Permission covers exactly one synchronous poll.
use crate::budget::{ByteLease, BytePool};
use std::{
    future::Future,
    io,
    num::NonZeroU32,
    pin::Pin,
    sync::Arc,
    task::{Context, Poll},
};
use tokio::sync::{AcquireError, OwnedSemaphorePermit, Semaphore};

pub(crate) const SCRATCH_BYTES: u32 = 4 << 20;
pub(crate) struct SharedScratch {
    _charge: ByteLease,
    semaphore: Arc<Semaphore>,
}
impl SharedScratch {
    pub(crate) fn reserve(incoming: &BytePool) -> Option<Arc<Self>> {
        let amount = NonZeroU32::new(SCRATCH_BYTES).expect("nonzero TLS parser scratch");
        Some(Arc::new(Self {
            _charge: incoming.reserve(amount)?,
            semaphore: Arc::new(Semaphore::new(1)),
        }))
    }
    pub(crate) fn waiter(self: &Arc<Self>) -> ScratchWait {
        ScratchWait {
            scratch: self.clone(),
            waiting: None,
        }
    }
}
type Waiter = Pin<Box<dyn Future<Output = Result<OwnedSemaphorePermit, AcquireError>> + Send>>;
pub(crate) struct ScratchWait {
    scratch: Arc<SharedScratch>,
    waiting: Option<Waiter>,
}
impl ScratchWait {
    pub(crate) fn poll(
        &mut self,
        context: &mut Context<'_>,
    ) -> Poll<io::Result<OwnedSemaphorePermit>> {
        let waiter = self
            .waiting
            .get_or_insert_with(|| Box::pin(self.scratch.semaphore.clone().acquire_owned()));
        match waiter.as_mut().poll(context) {
            Poll::Pending => Poll::Pending,
            Poll::Ready(result) => {
                self.waiting = None;
                Poll::Ready(result.map_err(io::Error::other))
            }
        }
    }
}

#[cfg(test)]
mod tests;
