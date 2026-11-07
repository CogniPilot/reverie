#[derive(Debug)]
pub enum WorkerReportError {
    Stopping,
    Peer,
    Frame,
    Refused,
    Io(std::io::Error),
    Telemetry(super::TelemetryError),
    Finalization {
        primary: Box<Self>,
        secondary: Box<Self>,
    },
    Unconfirmed,
}
impl WorkerReportError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Stopping => "Worker broker is stopping",
            Self::Peer => "Worker peer identity is not authorized",
            Self::Frame => "Worker frame is too large",
            Self::Refused => "TELEMETRY_REPORT_REFUSED",
            Self::Io(_) => "Worker transport failed",
            Self::Telemetry(_) => "TELEMETRY_REPORT_REFUSED",
            Self::Finalization { .. } | Self::Unconfirmed => "WORKER_TELEMETRY_CLOSE_UNCONFIRMED",
        }
    }
    pub(super) fn quiet_disconnect(&self) -> bool {
        matches!(self, Self::Io(error) if matches!(error.kind(),
            std::io::ErrorKind::UnexpectedEof | std::io::ErrorKind::BrokenPipe |
            std::io::ErrorKind::ConnectionAborted | std::io::ErrorKind::ConnectionRefused |
            std::io::ErrorKind::ConnectionReset))
    }
    pub(super) fn wire_message(&self) -> &'static str {
        match self {
            Self::Unconfirmed | Self::Finalization { .. } => "Worker transport failed",
            _ => self.code(),
        }
    }
}
impl std::fmt::Display for WorkerReportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.code())
    }
}
impl std::error::Error for WorkerReportError {}
impl From<std::io::Error> for WorkerReportError {
    fn from(e: std::io::Error) -> Self {
        Self::Io(e)
    }
}
impl From<super::TelemetryError> for WorkerReportError {
    fn from(e: super::TelemetryError) -> Self {
        Self::Telemetry(e)
    }
}
pub(super) type Result<T> = std::result::Result<T, WorkerReportError>;
pub(super) fn finalized<T>(result: Result<T>, closed: Result<()>) -> Result<T> {
    match (result, closed) {
        (Ok(v), Ok(())) => Ok(v),
        (Err(e), Ok(())) | (Ok(_), Err(e)) => Err(e),
        (Err(primary), Err(secondary)) => Err(WorkerReportError::Finalization {
            primary: Box::new(primary),
            secondary: Box::new(secondary),
        }),
    }
}
