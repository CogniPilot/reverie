use super::*;
#[derive(Debug)]
pub enum GateError {
    Actor(Box<reverie_host::worker_reports::ResourceJournalError>),
    RamPolicy(reverie_contracts::ram_migration::RamMigrationError),
    OriginalSource(Box<crate::installing_broker::StorageWorkflowError>),
    SourceStopData(reverie_contracts::worker_source_stop::SourceStopDataError),
    NativeSourceStopUncertain {
        cause: Box<Self>,
    },
    GpuData(reverie_contracts::gpu_access::GpuDataError),
    ImageFiles(reverie_host::worker_image::ImageFileError),
    GpuHost(reverie_host::gpu_access::GpuHostError),
    GpuApplyUncertain {
        cause: Box<Self>,
    },
    StartData(reverie_contracts::reservation_baseline::StartDataError),
    NativeStartIntentUncertain {
        cause: Box<Self>,
    },
    Intent(reverie_host::worker_intent::IntentHostError),
    LaptopData(reverie_contracts::broker_laptop::LaptopReadError),
    FullPolicy(crate::worker_validation::WorkerValidationError),
    PolicyFile(reverie_contracts::worker_config::WorkerConfigError),
    PolicyData(reverie_contracts::reservation_policy::PolicyDataError),
    PreparationConfigUncertain {
        cause: Box<Self>,
    },
    Reload(reverie_contracts::resource_reload::ReloadDataError),
    Value(reverie_core::ValueError),
    PublicationData(reverie_contracts::reservation_publication::PublicationDataError),
    PreparationIntentUncertain {
        cause: Box<Self>,
    },
    PreparationPublicationUncertain {
        cause: Box<Self>,
    },
    Draft(reverie_contracts::reservation_draft::DraftDataError),
    Baseline(reverie_contracts::reservation_baseline::BaselineDataError),
    HostJob(reverie_contracts::host_jobs::HostJobDataError),
    HostJobPath(reverie_host::host_jobs::HostJobPathError),
    History(reverie_contracts::reservation_history::HistoryError),
    Capacity(reverie_core::capacity::CapacityError),
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
    SharedJournal(Arc<JournalError>),
    Policy(WorkerValidationError),
    Configuration(EngineDataError),
    Refused(&'static str),
    ClaimUncertain {
        cause: Box<Self>,
    },
    Finalization {
        primary: Box<Self>,
        secondary: Box<Self>,
    },
}
impl GateError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Actor(error) => error.code(),
            Self::RamPolicy(error) => error.code(),
            Self::OriginalSource(error) => error.code(),
            Self::SourceStopData(error) => error.code(),
            Self::NativeSourceStopUncertain { .. } => {
                "RESOURCE_NATIVE_SOURCE_STOP_UNCERTAIN_KEEP_CLAIM"
            }
            Self::GpuData(error) => error.code(),
            Self::ImageFiles(error) => error.code(),
            Self::GpuHost(error) => error.code(),
            Self::GpuApplyUncertain { .. } => "GPU_APPLY_REQUIRES_RECONCILIATION",
            Self::StartData(error) => error.code(),
            Self::NativeStartIntentUncertain { .. } => {
                "RESOURCE_NATIVE_START_INTENT_UNCERTAIN_KEEP_CLAIM"
            }
            Self::Intent(error) => error.code(),
            Self::LaptopData(error) => error.code(),
            Self::FullPolicy(error) => error.code(),
            Self::PolicyFile(error) => error.code(),
            Self::PolicyData(error) => error.code(),
            Self::PreparationConfigUncertain { .. } => {
                "RESOURCE_PREPARATION_CONFIG_UNCERTAIN_KEEP_ALL_EVIDENCE"
            }
            Self::Reload(error) => error.code(),
            Self::Value(error) => error.code(),
            Self::PublicationData(error) => error.code(),
            Self::PreparationIntentUncertain { .. } => {
                "RESOURCE_PREPARATION_INTENT_UNCERTAIN_KEEP_CLAIM"
            }
            Self::PreparationPublicationUncertain { .. } => {
                "RESOURCE_PREPARATION_PUBLICATION_UNCERTAIN_KEEP_CLAIM"
            }
            Self::Draft(error) => error.code(),
            Self::Baseline(error) => error.code(),
            Self::HostJob(error) => error.code(),
            Self::HostJobPath(error) => error.code(),
            Self::History(error) => error.code(),
            Self::Capacity(error) => error.code(),
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
            Self::SharedJournal(error) => error.code(),
            Self::Policy(_) => "WORKER_VALIDATION_DATA",
            Self::Configuration(error) => error.code(),
            Self::Refused(code) => code,
            Self::ClaimUncertain { .. } => "CLAIM_OR_RESPONSE_UNCERTAIN_KEEP_ALL_CLAIMS",
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
            Self::Actor(error) => Some(error.as_ref()),
            Self::RamPolicy(error) => Some(error),
            Self::OriginalSource(error) => Some(error.as_ref()),
            Self::SourceStopData(error) => Some(error),
            Self::NativeSourceStopUncertain { cause } => Some(cause.as_ref()),
            Self::GpuData(error) => Some(error),
            Self::ImageFiles(error) => Some(error),
            Self::GpuHost(error) => Some(error),
            Self::GpuApplyUncertain { cause } => Some(cause),
            Self::StartData(error) => Some(error),
            Self::NativeStartIntentUncertain { cause } => Some(cause),
            Self::Intent(error) => Some(error),
            Self::LaptopData(error) => Some(error),
            Self::FullPolicy(error) => Some(error),
            Self::PolicyFile(error) => Some(error),
            Self::PolicyData(error) => Some(error),
            Self::PreparationConfigUncertain { cause } => Some(cause),
            Self::Reload(error) => Some(error),
            Self::Value(error) => Some(error),
            Self::PublicationData(error) => Some(error),
            Self::PreparationIntentUncertain { cause }
            | Self::PreparationPublicationUncertain { cause } => Some(cause),
            Self::Draft(error) => Some(error),
            Self::Baseline(error) => Some(error),
            Self::HostJob(error) => Some(error),
            Self::HostJobPath(error) => Some(error),
            Self::History(error) => Some(error),
            Self::Capacity(error) => Some(error),
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
            Self::SharedJournal(error) => Some(error.as_ref()),
            Self::Policy(error) => Some(error),
            Self::Configuration(error) => Some(error),
            Self::Finalization { primary, .. } => Some(primary),
            Self::Refused(_) => None,
            Self::ClaimUncertain { cause } => Some(cause),
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
from_error!(reverie_host::worker_image::ImageFileError, ImageFiles);
from_error!(
    reverie_contracts::ram_migration::RamMigrationError,
    RamPolicy
);
from_error!(
    reverie_contracts::reservation_baseline::StartDataError,
    StartData
);
from_error!(reverie_host::worker_intent::IntentHostError, Intent);
from_error!(
    reverie_contracts::broker_laptop::LaptopReadError,
    LaptopData
);
from_error!(crate::worker_validation::WorkerValidationError, FullPolicy);
from_error!(
    reverie_contracts::worker_config::WorkerConfigError,
    PolicyFile
);
from_error!(
    reverie_contracts::reservation_policy::PolicyDataError,
    PolicyData
);
from_error!(reverie_contracts::resource_reload::ReloadDataError, Reload);
from_error!(reverie_core::ValueError, Value);
from_error!(
    reverie_contracts::reservation_publication::PublicationDataError,
    PublicationData
);
from_error!(reverie_contracts::reservation_draft::DraftDataError, Draft);
from_error!(
    reverie_contracts::reservation_baseline::BaselineDataError,
    Baseline
);
from_error!(reverie_contracts::host_jobs::HostJobDataError, HostJob);
from_error!(reverie_host::host_jobs::HostJobPathError, HostJobPath);
from_error!(
    reverie_contracts::reservation_history::HistoryError,
    History
);
from_error!(reverie_core::capacity::CapacityError, Capacity);
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
from_error!(reverie_contracts::gpu_access::GpuDataError, GpuData);
from_error!(reverie_host::gpu_access::GpuHostError, GpuHost);
pub(super) type Result<T> = std::result::Result<T, GateError>;
pub(super) fn need(value: bool, code: &'static str) -> Result<()> {
    if value {
        Ok(())
    } else {
        Err(GateError::Refused(code))
    }
}
pub(crate) fn finalized<T>(result: Result<T>, closed: Result<()>) -> Result<T> {
    match (result, closed) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(error), Ok(())) | (Ok(_), Err(error)) => Err(error),
        (Err(primary), Err(secondary)) => Err(GateError::Finalization {
            primary: Box::new(primary),
            secondary: Box::new(secondary),
        }),
    }
}
