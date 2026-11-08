use super::*;
#[derive(Debug)]
pub(crate) enum StoppedRamError {
    Storage(Box<StorageWorkflowError>),
    Native(Box<crate::reservation_observer::ObserverError>),
    Refused(&'static str),
    Finalization {
        primary: Arc<Self>,
        cleanup: Arc<Self>,
    },
}
impl StoppedRamError {
    pub(crate) fn code(&self) -> &'static str {
        match self {
            Self::Storage(error) => error.code(),
            Self::Native(error) => error.code(),
            Self::Refused(code) => code,
            Self::Finalization { .. } => "RAM_STOPPED_SOURCE_FINALIZATION",
        }
    }
}
impl std::fmt::Display for StoppedRamError {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Finalization { primary, cleanup } => {
                write!(out, "{}: {primary}; cleanup: {cleanup}", self.code())
            }
            _ => out.write_str(self.code()),
        }
    }
}
impl std::error::Error for StoppedRamError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Storage(error) => Some(error.as_ref()),
            Self::Native(error) => Some(error.as_ref()),
            Self::Finalization { primary, .. } => Some(primary.as_ref()),
            Self::Refused(_) => None,
        }
    }
}
pub(super) fn storage(error: impl Into<StorageWorkflowError>) -> Arc<StoppedRamError> {
    Arc::new(StoppedRamError::Storage(Box::new(error.into())))
}
pub(super) fn native(error: crate::reservation_observer::ObserverError) -> Arc<StoppedRamError> {
    Arc::new(StoppedRamError::Native(Box::new(error)))
}
pub(super) fn refused(code: &'static str) -> Arc<StoppedRamError> {
    Arc::new(StoppedRamError::Refused(code))
}
pub(super) fn finalized<T>(body: StopResult<T>, cleanup: StopResult<()>) -> StopResult<T> {
    match (body, cleanup) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(error), Ok(())) | (Ok(_), Err(error)) => Err(error),
        (Err(primary), Err(cleanup)) => {
            Err(Arc::new(StoppedRamError::Finalization { primary, cleanup }))
        }
    }
}
pub(crate) struct StoppedRamRetainFailure {
    pub(super) claim: StorageClaim,
    pub(super) context: ObservationContext,
    pub(super) cause: Arc<StoppedRamError>,
}
impl StoppedRamRetainFailure {
    pub(crate) fn into_parts(
        self: Box<Self>,
    ) -> (StorageClaim, ObservationContext, Arc<StoppedRamError>) {
        (self.claim, self.context, self.cause)
    }
}
pub(crate) struct StoppedRamRestoreFailure {
    pub(super) owner: StoppedRamSource,
    pub(super) cause: Arc<StoppedRamError>,
}
impl StoppedRamRestoreFailure {
    pub(crate) fn into_parts(self: Box<Self>) -> (StoppedRamSource, Arc<StoppedRamError>) {
        (self.owner, self.cause)
    }
}
