#[derive(Debug)]
pub enum WorkerReportError {
    Stopping,
    Peer,
    Frame,
    Refused,
    LaunchKind,
    Io(std::io::Error),
    Telemetry(super::TelemetryError),
    Launch(reverie_contracts::worker_launch::LaunchDataError),
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
            Self::LaunchKind => "Expected worker launch request",
            Self::Io(_) => "Worker transport failed",
            Self::Telemetry(_) => "TELEMETRY_REPORT_REFUSED",
            Self::Launch(error) => launch_message(error),
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
fn launch_message(error: &reverie_contracts::worker_launch::LaunchDataError) -> &'static str {
    use reverie_contracts::worker_launch::LaunchDataError as Data;
    use reverie_core::worker_launch::LaunchRuleError as Rule;
    match error {
        Data::Frame => "Worker frame is too large",
        Data::Session => "Invalid session identifier",
        Data::Attach => "Invalid attach-only request",
        Data::Rule(Rule::Directory) => "Invalid worker directory",
        Data::Rule(Rule::OutsideGrants) => "Worker directory is outside the owner grants",
        Data::Rule(Rule::Command) => "Invalid worker command",
        Data::Rule(Rule::Environment) => "Invalid worker environment",
        Data::Rule(Rule::Terminal) => "Invalid terminal dimensions",
        // The existing request codec retains a typed JSON refusal, but not
        // CPython's detailed byte/line diagnostic. The complete dispatcher
        // must qualify that remaining diagnostic seam before selection.
        _ => "Invalid worker request",
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
