use crate::ObservationError;
use reverie_contracts::worker_child::ChildDataError;
use reverie_core::worker_child::ChildEnvironmentError;
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ChildPhase {
    Record,
    Parse,
    Consume,
    Environment,
    Relay,
    Directory,
    Execute,
    Receipt,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RecordDisposition {
    Untouched,
    UnlinkAttempted,
    Consumed,
    Delegated,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ChildCleanup {
    RecordDataClose,
    RecordAnchorClose,
    RecordDirectoryClose,
    PendingStart,
    Unreaped,
    PidfdClose,
    HandshakeClose,
    Signal,
    ReceiptPublication,
    ReceiptWriterClose,
    ReceiptAnchorClose,
    ReceiptDirectoryClose,
    ReceiptTemporaryRetained,
}
#[derive(Debug)]
pub enum ChildCause {
    Io(std::io::Error),
    Observation(ObservationError),
    Data(ChildDataError),
    Environment(ChildEnvironmentError),
    Scope,
    Custody,
    Changed,
    Encoding,
    Spawn,
    Finalization,
    Cancelled,
    Deadline,
}
#[derive(Debug)]
pub struct ChildError {
    phase: ChildPhase,
    cause: ChildCause,
    record: RecordDisposition,
    cleanup: Vec<ChildCleanup>,
}
impl ChildError {
    pub(super) fn with_cleanup_from(mut self, other: &Self) -> Self {
        self.cleanup.extend_from_slice(&other.cleanup);
        self
    }
    pub(super) fn new(phase: ChildPhase, cause: ChildCause) -> Self {
        Self {
            phase,
            cause,
            record: RecordDisposition::Untouched,
            cleanup: Vec::new(),
        }
    }
    pub(super) fn spent(mut self, record: RecordDisposition) -> Self {
        self.record = record;
        self
    }
    pub(super) fn finalizer(mut self, fault: ChildCleanup) -> Self {
        self.cleanup.push(fault);
        self
    }
    pub(super) fn at_phase(mut self, phase: ChildPhase) -> Self {
        self.phase = phase;
        self
    }
    pub fn phase(&self) -> ChildPhase {
        self.phase
    }
    pub fn cause(&self) -> &ChildCause {
        &self.cause
    }
    pub fn record_disposition(&self) -> RecordDisposition {
        self.record
    }
    pub fn cleanup_faults(&self) -> &[ChildCleanup] {
        &self.cleanup
    }
}
impl std::fmt::Display for ChildError {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(out, "WORKER_CHILD_{:?}", self.phase)
    }
}
impl std::error::Error for ChildError {}
pub(super) type Result<T> = std::result::Result<T, ChildError>;
