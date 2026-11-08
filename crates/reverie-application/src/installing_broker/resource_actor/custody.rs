//! Stateless native readers consume their descriptors before returning. Retain
//! their actual typed uncertainty with this original channel's counted hold.
use super::*;
use crate::reservation_observer::ObserverError;
use reverie_host::reservation_kernel::ReservationKernelError;
use reverie_store::storage_identity::IdentityError;
#[derive(Clone)]
pub(super) enum RetainedClose {
    Gate(Arc<GateError>),
    Company(Arc<IdentityError>),
    Kernel(Arc<ReservationKernelError>),
    Control(Arc<reverie_host::reservation_control::ControlHostError>),
}
impl RetainedClose {
    pub(super) fn error(&self) -> ResourceActorError {
        match self {
            Self::Gate(error) => ResourceActorError::RetainedGateClose(Arc::clone(error)),
            Self::Company(error) => ResourceActorError::RetainedCompanyClose(Arc::clone(error)),
            Self::Kernel(error) => ResourceActorError::RetainedKernelClose(Arc::clone(error)),
            Self::Control(error) => ResourceActorError::RetainedControlClose(Arc::clone(error)),
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
            ResourceActorError::Gate(error) => self.retain_gate_error(*error),
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
            ResourceActorError::RetainedControlClose(error) => {
                self.retain_close(RetainedClose::Control(error))
            }
            ResourceActorError::RetainedGateClose(error) => {
                self.retain_close(RetainedClose::Gate(error))
            }
            ResourceActorError::GateFinalization { primary, secondary } => {
                ResourceActorError::GateFinalization {
                    primary: Box::new(self.retain_stateless_error(*primary)),
                    secondary: Box::new(self.retain_stateless_error(*secondary)),
                }
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
    fn retain_gate_error(&mut self, cause: GateError) -> ResourceActorError {
        match cause {
            GateError::Observer(ObserverError::Kernel(error)) if error.has_unconfirmed_close() => {
                self.retain_close(RetainedClose::Kernel(Arc::new(error)))
            }
            GateError::Identity(error) if error.has_unconfirmed_close() => {
                self.retain_close(RetainedClose::Company(Arc::new(error)))
            }
            GateError::Control(error) if error.has_unconfirmed_close() => {
                self.retain_close(RetainedClose::Control(Arc::new(error)))
            }
            GateError::Finalization { primary, secondary } => {
                ResourceActorError::GateFinalization {
                    primary: Box::new(self.retain_gate_error(*primary)),
                    secondary: Box::new(self.retain_gate_error(*secondary)),
                }
            }
            other if super::error::gate_close_unknown(&other) => {
                self.retain_close(RetainedClose::Gate(Arc::new(other)))
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
