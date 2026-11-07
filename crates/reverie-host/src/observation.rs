use std::{fmt, io};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ObservationFault {
    CanonicalPath,
    ArtifactCustody,
    ArtifactBound,
    Changed,
    System,
    ReservationBound,
    ReservationStorageDirectory,
    ControlPath,
    ControlAncestor,
    ControlDirectory,
    AdmissionBusy,
    AdmissionRebound,
    AdmissionRequired,
}
impl ObservationFault {
    pub fn code(self) -> &'static str {
        match self {
            Self::CanonicalPath => "HOST_ARTIFACT_PATH",
            Self::ArtifactCustody => "HOST_ARTIFACT_CUSTODY",
            Self::ArtifactBound => "HOST_ARTIFACT_BOUND",
            Self::Changed => "HOST_ARTIFACT_CHANGED",
            Self::System => "HOST_ARTIFACT_SYSTEM",
            Self::ReservationBound => "RESERVATION_NATIVE_BOUND",
            Self::ReservationStorageDirectory => "RESERVATION_NATIVE_STORAGE_DIRECTORY",
            Self::ControlPath => "RESERVATION_CONTROL_PATH",
            Self::ControlAncestor => "RESERVATION_CONTROL_ANCESTOR",
            Self::ControlDirectory => "RESERVATION_CONTROL_DIRECTORY",
            Self::AdmissionBusy => "RESERVATION_ADMISSION_LOCK_BUSY",
            Self::AdmissionRebound => "RESERVATION_ADMISSION_LOCK_REBOUND",
            Self::AdmissionRequired => "RESERVATION_ADMISSION_LOCK_REQUIRED",
        }
    }
}
#[derive(Debug)]
pub enum ObservationError {
    Refused(ObservationFault),
    Io(io::Error),
    Finalization {
        primary: Box<Self>,
        secondary: Box<Self>,
    },
}
impl ObservationError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Refused(fault) => fault.code(),
            Self::Io(_) => "HOST_ARTIFACT_IO",
            Self::Finalization { .. } => "HOST_ARTIFACT_FINALIZATION",
        }
    }
}
impl fmt::Display for ObservationError {
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        output.write_str(self.code())
    }
}
impl std::error::Error for ObservationError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::Finalization { primary, .. } => Some(primary),
            _ => None,
        }
    }
}
impl From<io::Error> for ObservationError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}
pub(crate) type Result<T> = std::result::Result<T, ObservationError>;
pub(crate) fn need(condition: bool, fault: ObservationFault) -> Result<()> {
    if condition {
        Ok(())
    } else {
        Err(ObservationError::Refused(fault))
    }
}
pub(crate) fn finalized<T>(result: Result<T>, closed: Result<()>) -> Result<T> {
    match (result, closed) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(error), Ok(())) | (Ok(_), Err(error)) => Err(error),
        (Err(primary), Err(secondary)) => Err(ObservationError::Finalization {
            primary: Box::new(primary),
            secondary: Box::new(secondary),
        }),
    }
}
