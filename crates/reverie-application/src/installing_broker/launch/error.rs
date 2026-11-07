use super::*;
#[derive(Debug)]
pub enum WorkerDispatchError {
    Transport(WorkerReportError),
    Gate(GateError),
    Configuration {
        primary: GateError,
        cleanup: Option<WorkerReportError>,
    },
    Finalization {
        primary: GateError,
        cleanup: Option<WorkerReportError>,
    },
}
impl From<GateError> for WorkerDispatchError {
    fn from(error: GateError) -> Self {
        Self::Gate(error)
    }
}
impl From<WorkerReportError> for WorkerDispatchError {
    fn from(error: WorkerReportError) -> Self {
        Self::Transport(error)
    }
}
impl std::fmt::Display for WorkerDispatchError {
    fn fmt(&self, output: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Transport(error) => error.fmt(output),
            Self::Gate(error)
            | Self::Configuration { primary: error, .. }
            | Self::Finalization { primary: error, .. } => error.fmt(output),
        }
    }
}
impl std::error::Error for WorkerDispatchError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Transport(error) => Some(error),
            Self::Gate(error)
            | Self::Configuration { primary: error, .. }
            | Self::Finalization { primary: error, .. } => Some(error),
        }
    }
}
/// A prefix refusal retains the exact accepted connection. There is no raw
/// Runtime, admission or resource extractor, and no successful start result.
pub struct LaunchAdmissionFailure<'a> {
    pub(super) request: ReceivedWorkerLaunch<'a>,
    pub(super) cause: WorkerDispatchError,
}
impl LaunchAdmissionFailure<'_> {
    pub fn cause(&self) -> &WorkerDispatchError {
        &self.cause
    }
    pub fn close(&self, end: Instant) -> Result<(), WorkerReportError> {
        self.request.close(end)
    }
}
impl std::fmt::Debug for LaunchAdmissionFailure<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_tuple("LaunchAdmissionFailure")
            .field(&self.cause)
            .finish()
    }
}
impl std::fmt::Display for LaunchAdmissionFailure<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.cause.fmt(f)
    }
}
impl std::error::Error for LaunchAdmissionFailure<'_> {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.cause)
    }
}
