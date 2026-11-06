#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Fault {
    Busy,
    Cancelled,
    Deadline,
    Spawn,
    Identity,
    Read,
    OutputBound,
    Utf8,
    Exit,
    Finalization,
    Supervisor,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CleanupFault {
    PendingStart,
    Unreaped,
    OpenPipes,
    Signal,
    Identity,
    StdoutClose,
    StderrClose,
    PidfdClose,
    HandshakeClose,
    Supervisor,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct Error {
    pub(crate) fault: Fault,
    pub(crate) cleanup: Vec<CleanupFault>,
    pub(crate) uncertain: bool,
    pub(crate) may_have_started: bool,
}
impl Error {
    pub(super) fn new(fault: Fault) -> Self {
        Self {
            fault,
            cleanup: Vec::new(),
            uncertain: false,
            may_have_started: false,
        }
    }
    pub(super) fn pending(fault: Fault, cleanup: CleanupFault) -> Self {
        Self {
            fault,
            cleanup: vec![cleanup],
            uncertain: true,
            may_have_started: true,
        }
    }
    pub(super) fn before_start_pending(fault: Fault, cleanup: CleanupFault) -> Self {
        let mut error = Self::pending(fault, cleanup);
        error.may_have_started = false;
        error
    }
    pub(crate) fn is_uncertain(&self) -> bool {
        self.uncertain
    }
}
