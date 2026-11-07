use super::*;
#[derive(Debug)]
pub enum RecoveryError {
    Gate(GateError),
    Native(reverie_host::worker_recovery::WorkerRecoveryError),
    Memory(crate::worker_recovery::RecoveryMemoryError),
    Storage(StorageWorkflowError),
    StorageData(worker_storage::StorageError),
    Office(reverie_host::office::OfficeError),
    Resource(reverie_contracts::broker_resources::ResourceConfigError),
    Effective(resource_staging::ResourceServiceError),
    Refused(&'static str),
    Finalization {
        primary: Box<Self>,
        secondary: Box<Self>,
    },
}
impl std::fmt::Display for RecoveryError {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Gate(error) => error.fmt(out),
            Self::Native(error) => error.fmt(out),
            Self::Memory(error) => error.fmt(out),
            Self::Storage(error) => error.fmt(out),
            Self::StorageData(error) => error.fmt(out),
            Self::Office(error) => error.fmt(out),
            Self::Resource(error) => error.fmt(out),
            Self::Effective(error) => error.fmt(out),
            Self::Refused(code) => out.write_str(code),
            Self::Finalization { primary, .. } => primary.fmt(out),
        }
    }
}
impl std::error::Error for RecoveryError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(match self {
            Self::Gate(error) => error,
            Self::Native(error) => error,
            Self::Memory(error) => error,
            Self::Storage(error) => error,
            Self::StorageData(error) => error,
            Self::Office(error) => error,
            Self::Resource(error) => error,
            Self::Effective(error) => error,
            Self::Refused(_) => return None,
            Self::Finalization { primary, .. } => primary.as_ref(),
        })
    }
}
macro_rules! convert {
    ($from:ty,$variant:ident) => {
        impl From<$from> for RecoveryError {
            fn from(error: $from) -> Self {
                Self::$variant(error)
            }
        }
    };
}
convert!(GateError, Gate);
convert!(reverie_host::worker_recovery::WorkerRecoveryError, Native);
convert!(crate::worker_recovery::RecoveryMemoryError, Memory);
convert!(StorageWorkflowError, Storage);
convert!(worker_storage::StorageError, StorageData);
convert!(reverie_host::office::OfficeError, Office);
convert!(
    reverie_contracts::broker_resources::ResourceConfigError,
    Resource
);
convert!(resource_staging::ResourceServiceError, Effective);
pub(super) fn finalized(primary: RecoveryError, secondary: RecoveryError) -> RecoveryError {
    RecoveryError::Finalization {
        primary: Box::new(primary),
        secondary: Box::new(secondary),
    }
}
