//! Issued bytes are reserved before reads/grants, including data still in
//! transit. Moving a lease transfers its charge; cancellation drops it once.
use std::{fmt, num::NonZeroU32, sync::Arc};
use tokio::sync::{Notify, OwnedSemaphorePermit, Semaphore};

#[derive(Debug)]
struct Inner {
    capacity: usize,
    semaphore: Arc<Semaphore>,
    changed: Notify,
}
#[derive(Clone, Debug)]
pub struct BytePool(Arc<Inner>);
#[derive(Debug)]
pub struct ByteLease {
    pool: Arc<Inner>,
    permit: Option<OwnedSemaphorePermit>,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BudgetError {
    InvalidCapacity,
    InsufficientLease,
    DifferentPool,
}
impl fmt::Display for BudgetError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(out, "{self:?}")
    }
}
impl std::error::Error for BudgetError {}
impl BytePool {
    pub fn new(capacity: usize) -> Result<Self, BudgetError> {
        if capacity == 0 || capacity > Semaphore::MAX_PERMITS {
            return Err(BudgetError::InvalidCapacity);
        }
        Ok(Self(Arc::new(Inner {
            capacity,
            semaphore: Arc::new(Semaphore::new(capacity)),
            changed: Notify::new(),
        })))
    }
    pub fn available(&self) -> usize {
        self.0.semaphore.available_permits()
    }
    pub fn issued(&self) -> usize {
        self.0.capacity - self.available()
    }
    pub fn reserve(&self, bytes: NonZeroU32) -> Option<ByteLease> {
        self.0
            .semaphore
            .clone()
            .try_acquire_many_owned(bytes.get())
            .ok()
            .map(|permit| ByteLease {
                pool: self.0.clone(),
                permit: Some(permit),
            })
    }
    /// A wakeup only: the caller rechecks the pool and its fair waiter queue.
    pub async fn changed(&self) {
        self.0.changed.notified().await;
    }
}
impl ByteLease {
    pub fn bytes(&self) -> usize {
        self.permit.as_ref().expect("live lease").num_permits()
    }
    pub fn split(&mut self, bytes: NonZeroU32) -> Result<Self, BudgetError> {
        let permit = self
            .permit
            .as_mut()
            .expect("live lease")
            .split(bytes.get() as usize)
            .ok_or(BudgetError::InsufficientLease)?;
        Ok(Self {
            pool: self.pool.clone(),
            permit: Some(permit),
        })
    }
    pub fn merge(&mut self, mut other: Self) -> Result<(), BudgetError> {
        if !Arc::ptr_eq(&self.pool, &other.pool) {
            return Err(BudgetError::DifferentPool);
        }
        self.permit
            .as_mut()
            .expect("live lease")
            .merge(other.permit.take().expect("live lease"));
        Ok(())
    }
}
impl Drop for ByteLease {
    fn drop(&mut self) {
        drop(self.permit.take());
        self.pool.changed.notify_one();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn amount(bytes: u32) -> NonZeroU32 {
        NonZeroU32::new(bytes).unwrap()
    }
    #[test]
    fn split_transfer_merge_and_cancellation_keep_one_issued_budget() {
        let pool = BytePool::new(100).unwrap();
        let mut granted = pool.reserve(amount(80)).unwrap();
        let mut first = granted.split(amount(30)).unwrap();
        let second = granted.split(amount(20)).unwrap();
        assert_eq!(pool.issued(), 80);
        assert_eq!(granted.bytes(), 30);
        first.merge(second).unwrap();
        assert_eq!(first.bytes(), 50);
        assert!(pool.reserve(amount(21)).is_none());
        drop(granted);
        assert_eq!(pool.issued(), 50);
        drop(first);
        assert_eq!(pool.issued(), 0);
    }
    #[test]
    fn crossed_pool_merge_refuses_and_releases_only_the_consumed_lease() {
        let first = BytePool::new(10).unwrap();
        let second = BytePool::new(10).unwrap();
        let mut a = first.reserve(amount(10)).unwrap();
        let b = second.reserve(amount(10)).unwrap();
        assert_eq!(a.merge(b), Err(BudgetError::DifferentPool));
        assert_eq!(first.issued(), 10);
        assert_eq!(second.issued(), 0);
        assert_eq!(
            a.split(amount(11)).unwrap_err(),
            BudgetError::InsufficientLease
        );
        assert_eq!(a.bytes(), 10);
    }
}
