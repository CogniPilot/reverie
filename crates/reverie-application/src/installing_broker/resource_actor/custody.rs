//! Stateless native readers consume their descriptors before returning. Retain
//! their actual typed uncertainty with this original channel's counted hold.
use super::*;
use crate::reservation_observer::ObserverError;
use reverie_host::reservation_kernel::ReservationKernelError;
use reverie_store::storage_identity::IdentityError;
#[derive(Clone)]
pub(super) enum RetainedClose {
    Company(Arc<IdentityError>),
    Kernel(Arc<ReservationKernelError>),
}
impl RetainedClose {
    pub(super) fn error(&self) -> ResourceActorError {
        match self {
            Self::Company(error) => ResourceActorError::RetainedCompanyClose(Arc::clone(error)),
            Self::Kernel(error) => ResourceActorError::RetainedKernelClose(Arc::clone(error)),
        }
    }
}
impl Frame<'_> {
    pub(super) fn retain_stateless_result<T>(&mut self, result: Result<T>) -> Result<T> {
        match result {
            Err(error) if error.has_unconfirmed_close() => Err(self.retain_stateless_error(error)),
            other => other,
        }
    }
    fn retain_stateless_error(&mut self, cause: ResourceActorError) -> ResourceActorError {
        match cause {
            ResourceActorError::Gate(error) => self.retain_company_error(*error),
            ResourceActorError::Observer(ObserverError::Kernel(error))
                if error.has_unconfirmed_close() =>
            {
                self.retain_close(RetainedClose::Kernel(Arc::new(error)))
            }
            ResourceActorError::RetainedCompanyClose(error) => {
                self.retain_close(RetainedClose::Company(error))
            }
            ResourceActorError::RetainedKernelClose(error) => {
                self.retain_close(RetainedClose::Kernel(error))
            }
            ResourceActorError::Finalization { primary, secondary } => {
                ResourceActorError::Finalization {
                    primary: Box::new(self.retain_stateless_error(*primary)),
                    secondary: Box::new(self.retain_stateless_error(*secondary)),
                }
            }
            other => other,
        }
    }
    fn retain_company_error(&mut self, cause: GateError) -> ResourceActorError {
        match cause {
            GateError::Identity(error) if error.has_unconfirmed_close() => {
                self.retain_close(RetainedClose::Company(Arc::new(error)))
            }
            other => other.into(),
        }
    }
    fn retain_close(&mut self, cause: RetainedClose) -> ResourceActorError {
        self.unconfirmed.get_or_insert_with(|| cause.clone());
        self.failed = true;
        cause.error()
    }
}
