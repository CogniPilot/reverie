use super::*;
#[derive(Debug)]
pub enum GateError {
    Resource(reverie_contracts::broker_resources::ResourceConfigError),
    Profile(reverie_store::StoreError),
    Identity(reverie_store::storage_identity::IdentityError),
    ObservationData(reverie_contracts::reservation_observation::ObservationDataError),
    Effective(crate::resource_staging::ResourceServiceError),
    Operation(reverie_core::operations::OperationError),
    Control(ControlHostError),
    ControlData(ControlDataError),
    Image(ImageHostError),
    Observer(ObserverError),
    Journal(JournalError),
    Policy(WorkerValidationError),
    Configuration(EngineDataError),
    Refused(&'static str),
    Finalization {
        primary: Box<Self>,
        secondary: Box<Self>,
    },
}
impl GateError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Resource(error) => error.code(),
            Self::Profile(error) => error.code(),
            Self::Identity(error) => error.code(),
            Self::ObservationData(error) => error.code(),
            Self::Effective(error) => error.code(),
            Self::Operation(error) => error.code(),
            Self::Control(error) => error.code(),
            Self::ControlData(error) => error.code(),
            Self::Image(error) => error.code(),
            Self::Observer(error) => error.code(),
            Self::Journal(error) => error.code(),
            Self::Policy(_) => "WORKER_VALIDATION_DATA",
            Self::Configuration(error) => error.code(),
            Self::Refused(code) => code,
            Self::Finalization { .. } => "RESERVATION_ADMISSION_FINALIZATION",
        }
    }
}
impl std::fmt::Display for GateError {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.write_str(self.code())
    }
}
impl std::error::Error for GateError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Resource(error) => Some(error),
            Self::Profile(error) => Some(error),
            Self::Identity(error) => Some(error),
            Self::ObservationData(error) => Some(error),
            Self::Effective(error) => Some(error),
            Self::Operation(error) => Some(error),
            Self::Control(error) => Some(error),
            Self::ControlData(error) => Some(error),
            Self::Image(error) => Some(error),
            Self::Observer(error) => Some(error),
            Self::Journal(error) => Some(error),
            Self::Policy(error) => Some(error),
            Self::Configuration(error) => Some(error),
            Self::Finalization { primary, .. } => Some(primary),
            Self::Refused(_) => None,
        }
    }
}
macro_rules! from_error {
    ($error:ty,$variant:ident) => {
        impl From<$error> for GateError {
            fn from(error: $error) -> Self {
                Self::$variant(error)
            }
        }
    };
}
from_error!(ControlHostError, Control);
from_error!(ControlDataError, ControlData);
from_error!(ImageHostError, Image);
from_error!(ObserverError, Observer);
from_error!(JournalError, Journal);
from_error!(WorkerValidationError, Policy);
from_error!(EngineDataError, Configuration);
from_error!(
    reverie_contracts::broker_resources::ResourceConfigError,
    Resource
);
from_error!(reverie_store::StoreError, Profile);
from_error!(reverie_store::storage_identity::IdentityError, Identity);
from_error!(
    reverie_contracts::reservation_observation::ObservationDataError,
    ObservationData
);
from_error!(crate::resource_staging::ResourceServiceError, Effective);
from_error!(reverie_core::operations::OperationError, Operation);
pub(super) type Result<T> = std::result::Result<T, GateError>;
pub(super) fn need(value: bool, code: &'static str) -> Result<()> {
    if value {
        Ok(())
    } else {
        Err(GateError::Refused(code))
    }
}
pub(super) fn finalized<T>(result: Result<T>, closed: Result<()>) -> Result<T> {
    match (result, closed) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(error), Ok(())) | (Ok(_), Err(error)) => Err(error),
        (Err(primary), Err(secondary)) => Err(GateError::Finalization {
            primary: Box::new(primary),
            secondary: Box::new(secondary),
        }),
    }
}
