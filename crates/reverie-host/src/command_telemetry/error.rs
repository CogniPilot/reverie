use reverie_contracts::command_telemetry::TelemetryDataError;
#[derive(Debug)]
pub enum TelemetryError {
    Data(TelemetryDataError),
    Configuration(reverie_core::worker_options::WorkerOptionError),
    Storage(crate::worker_storage::StorageError),
    Io(std::io::Error),
    Engine(crate::engine_metadata::EngineError),
    Runtime,
    Identity(reverie_store::storage_identity::IdentityError),
    Observation(crate::ObservationError),
    Store(reverie_store::command_failures::FailureStoreError),
    Finalized {
        primary: Box<Self>,
        secondary: Box<Self>,
    },
}
impl std::fmt::Display for TelemetryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.code())
    }
}
impl std::error::Error for TelemetryError {}
impl From<TelemetryDataError> for TelemetryError {
    fn from(e: TelemetryDataError) -> Self {
        Self::Data(e)
    }
}
impl From<reverie_core::worker_options::WorkerOptionError> for TelemetryError {
    fn from(e: reverie_core::worker_options::WorkerOptionError) -> Self {
        Self::Configuration(e)
    }
}
impl From<crate::worker_storage::StorageError> for TelemetryError {
    fn from(e: crate::worker_storage::StorageError) -> Self {
        Self::Storage(e)
    }
}
impl From<std::io::Error> for TelemetryError {
    fn from(e: std::io::Error) -> Self {
        Self::Io(e)
    }
}
impl From<crate::engine_metadata::EngineError> for TelemetryError {
    fn from(e: crate::engine_metadata::EngineError) -> Self {
        Self::Engine(e)
    }
}
pub(super) type Result<T> = std::result::Result<T, TelemetryError>;

impl From<reverie_store::storage_identity::IdentityError> for TelemetryError {
    fn from(e: reverie_store::storage_identity::IdentityError) -> Self {
        Self::Identity(e)
    }
}
impl From<crate::ObservationError> for TelemetryError {
    fn from(e: crate::ObservationError) -> Self {
        Self::Observation(e)
    }
}
impl From<reverie_store::command_failures::FailureStoreError> for TelemetryError {
    fn from(e: reverie_store::command_failures::FailureStoreError) -> Self {
        Self::Store(e)
    }
}
pub(super) fn finalized<T>(result: Result<T>, close: Result<()>) -> Result<T> {
    match (result, close) {
        (Ok(v), Ok(())) => Ok(v),
        (Err(e), Ok(())) | (Ok(_), Err(e)) => Err(e),
        (Err(primary), Err(secondary)) => Err(TelemetryError::Finalized {
            primary: Box::new(primary),
            secondary: Box::new(secondary),
        }),
    }
}

impl TelemetryError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Data(error) => error.code(),
            Self::Configuration(_) => "TELEMETRY_CONFIG_REFUSED",
            Self::Engine(_) => "TELEMETRY_INVENTORY_UNCONFIRMED",
            Self::Store(_) => "TELEMETRY_STORE_REFUSED",
            Self::Identity(_) => "TELEMETRY_BINDING_REFUSED",
            Self::Runtime => "TELEMETRY_RUNTIME_REFUSED",
            Self::Finalized { primary, .. } => primary.code(),
            Self::Storage(_) | Self::Io(_) | Self::Observation(_) => "TELEMETRY_BOUNDARY_REFUSED",
        }
    }
}
