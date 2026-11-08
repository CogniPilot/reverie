//! Stateless native readers consume their descriptors before returning. Retain
//! their actual typed uncertainty with this original channel's counted hold.
use super::*;
impl Frame<'_> {
    pub(super) fn retain_stateless_result<T>(&mut self, result: Result<T>) -> Result<T> {
        match result {
            Err(cause) if cause.has_unconfirmed_close() => {
                let cause = Arc::new(cause);
                self.unconfirmed.get_or_insert_with(|| Arc::clone(&cause));
                self.failed = true;
                Err(ResourceActorError::RetainedClose(cause))
            }
            other => other,
        }
    }
}
