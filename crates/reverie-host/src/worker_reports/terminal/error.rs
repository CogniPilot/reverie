use super::*;
#[derive(Debug)]
pub enum ViewerRelayError {
    Transport(WorkerReportError),
    Laptop(Arc<crate::worker_laptop::LaptopError>),
    Intent(crate::worker_intent::IntentHostError),
    Data(reverie_contracts::worker_launch::TerminalFrameError),
    Receipt(reverie_contracts::worker_launch::ExitReceiptError),
    PaneDead,
    Phase,
    Finalization {
        primary: Box<Self>,
        secondary: Box<Self>,
    },
}
impl ViewerRelayError {
    pub(super) fn busy(&self) -> bool {
        matches!(self,Self::Laptop(error) if matches!(error.as_ref(),crate::worker_laptop::LaptopError::Refused("VIEWER_BUSY"|"WORKER_LAPTOP_RETAINED"|"WORKER_EXISTING_VIEWER_RETAINED")))
    }
    pub(super) fn quiet_disconnect(&self) -> bool {
        matches!(self,Self::Transport(error) if error.quiet_disconnect())
    }
}
impl std::fmt::Display for ViewerRelayError {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Transport(error)=>out.write_str(error.wire_message()),
            Self::Data(error)=>error.fmt(out),
            Self::PaneDead=>out.write_str("Laptop terminal pane exited without a completion receipt; use owner Restart to recover"),
            _=>out.write_str("Worker transport failed"),
        }
    }
}
impl std::error::Error for ViewerRelayError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Transport(error) => Some(error),
            Self::Laptop(error) => Some(error.as_ref()),
            Self::Intent(error) => Some(error),
            Self::Data(error) => Some(error),
            Self::Receipt(error) => Some(error),
            Self::Finalization { primary, .. } => Some(primary.as_ref()),
            Self::PaneDead | Self::Phase => None,
        }
    }
}
impl From<WorkerReportError> for ViewerRelayError {
    fn from(error: WorkerReportError) -> Self {
        Self::Transport(error)
    }
}
impl From<crate::worker_laptop::LaptopError> for ViewerRelayError {
    fn from(error: crate::worker_laptop::LaptopError) -> Self {
        Self::Laptop(Arc::new(error))
    }
}
