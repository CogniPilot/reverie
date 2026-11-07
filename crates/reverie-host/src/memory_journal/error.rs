use crate::captured_client::{self, CleanupFault};
use reverie_contracts::{memory_cli::JournalReplyError, storage_identity::MetadataText};
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum JournalClientFault {
    Bootstrap,
    Arguments,
    Request,
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
    Reply,
    UnknownSave,
}
#[derive(Debug)]
pub struct JournalClientError {
    fault: JournalClientFault,
    cleanup: Vec<CleanupFault>,
    process_uncertain: bool,
    save_unknown: bool,
    message: Option<MetadataText>,
}
impl JournalClientError {
    pub(super) fn new(fault: JournalClientFault) -> Self {
        Self {
            fault,
            cleanup: Vec::new(),
            process_uncertain: false,
            save_unknown: false,
            message: None,
        }
    }
    pub(super) fn unknown_save() -> Self {
        let mut error = Self::new(JournalClientFault::UnknownSave);
        error.save_unknown = true;
        error
    }
    pub(super) fn capture(error: captured_client::Error, unknown: bool) -> Self {
        use captured_client::Fault;
        let fault = match error.fault {
            Fault::Busy => JournalClientFault::Busy,
            Fault::Cancelled => JournalClientFault::Cancelled,
            Fault::Deadline => JournalClientFault::Deadline,
            Fault::Spawn => JournalClientFault::Spawn,
            Fault::Identity => JournalClientFault::Identity,
            Fault::Read => JournalClientFault::Read,
            Fault::OutputBound => JournalClientFault::OutputBound,
            Fault::Utf8 => JournalClientFault::Utf8,
            Fault::Exit => JournalClientFault::Exit,
            Fault::Finalization => JournalClientFault::Finalization,
            Fault::Supervisor => JournalClientFault::Supervisor,
        };
        Self {
            fault,
            cleanup: error.cleanup,
            process_uncertain: error.uncertain,
            save_unknown: unknown,
            message: None,
        }
    }
    pub(super) fn reply(error: JournalReplyError, unknown: bool) -> Self {
        let message = match error {
            JournalReplyError::Refused(message) => Some(message),
            JournalReplyError::Malformed => None,
        };
        Self {
            fault: JournalClientFault::Reply,
            cleanup: Vec::new(),
            process_uncertain: false,
            save_unknown: unknown,
            message,
        }
    }
    pub fn fault(&self) -> JournalClientFault {
        self.fault
    }
    pub fn cleanup_faults(&self) -> &[CleanupFault] {
        &self.cleanup
    }
    pub fn process_is_unconfirmed(&self) -> bool {
        self.process_uncertain
    }
    pub fn save_is_unconfirmed(&self) -> bool {
        self.save_unknown
    }
    pub fn message(&self) -> Option<&MetadataText> {
        self.message.as_ref()
    }
}
impl std::fmt::Display for JournalClientError {
    fn fmt(&self, output: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        output.write_str(if self.save_unknown {
            "journal save was not confirmed; inspect the journal before another save"
        } else if self.process_uncertain {
            "journal client cleanup is unconfirmed"
        } else if self.fault == JournalClientFault::Bootstrap {
            "the packaged TypeScript journal client is unavailable; no journal request was dispatched"
        } else {
            "journal client refused"
        })
    }
}
impl std::error::Error for JournalClientError {}
