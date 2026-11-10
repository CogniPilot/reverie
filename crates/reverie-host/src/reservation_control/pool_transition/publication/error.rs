use super::*;
use std::{fmt, ops::Deref, sync::MutexGuard};

/// The first whole typed failure stays in the original pending owner's ledger.
/// The mutex permits shared custody of errors whose native owners are !Sync.
pub struct PoolPublicationFailure {
    code: &'static str,
    unconfirmed_close: bool,
    cause: Mutex<ControlHostError>,
}
/// Read-only access to the retained original cause, never replacement custody.
pub struct PoolPublicationCause<'a>(MutexGuard<'a, ControlHostError>);
impl Deref for PoolPublicationCause<'_> {
    type Target = ControlHostError;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}
impl PoolPublicationFailure {
    pub fn code(&self) -> &'static str {
        self.code
    }
    pub fn has_unconfirmed_close(&self) -> bool {
        self.unconfirmed_close
    }
    pub fn cause(&self) -> Result<PoolPublicationCause<'_>> {
        self.cause
            .lock()
            .map(PoolPublicationCause)
            .map_err(|_| ControlHostError::Refused("POOL_PUBLICATION_CAUSE_OPAQUE"))
    }
}
impl fmt::Debug for PoolPublicationFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_tuple("PoolPublicationFailure")
            .field(&self.code)
            .finish()
    }
}
impl fmt::Display for PoolPublicationFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.code)
    }
}
impl std::error::Error for PoolPublicationFailure {}
#[derive(Default)]
pub(in super::super) struct FailureLedger(Mutex<Option<Arc<PoolPublicationFailure>>>);
impl FailureLedger {
    pub(in super::super) fn live(&self) -> Result<()> {
        let cause = self
            .0
            .lock()
            .map_err(|_| ControlHostError::Refused("POOL_PUBLICATION_REQUIRES_RECONCILIATION"))?;
        match cause.as_ref() {
            Some(cause) => Err(ControlHostError::PoolPublication(cause.clone())),
            None => Ok(()),
        }
    }
    pub(in super::super) fn finish<T>(&self, result: Result<T>) -> Result<T> {
        result.map_err(|error| {
            // Poison is not a recovery grant. Retain the original typed cause
            // even when its custody mutex has become opaque.
            let mut slot = self
                .0
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let cause = slot.get_or_insert_with(|| {
                Arc::new(PoolPublicationFailure {
                    code: error.code(),
                    unconfirmed_close: error.has_unconfirmed_close(),
                    cause: Mutex::new(error),
                })
            });
            ControlHostError::PoolPublication(cause.clone())
        })
    }
}
