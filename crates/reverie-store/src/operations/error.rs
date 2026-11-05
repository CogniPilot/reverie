use crate::{StoreError, StoreFault};
use reverie_core::operations::OperationError;
use std::fmt;
#[derive(Debug)]
pub enum JournalError {
    Refused(OperationError),
    Filesystem(StoreError),
    Finalization {
        primary: Box<Self>,
        secondary: Box<Self>,
    },
    CommitUncertain {
        cause: Box<Self>,
    },
}
impl JournalError {
    pub fn refusal(code: &'static str) -> Self {
        Self::Refused(OperationError::new(code))
    }
    pub fn is_uncertain(&self) -> bool {
        matches!(self, Self::CommitUncertain { .. })
    }
    pub fn code(&self) -> &'static str {
        match self {
            Self::Refused(error) => error.code(),
            Self::Filesystem(error) => filesystem_code(error),
            Self::Finalization { primary, .. } => primary.code(),
            Self::CommitUncertain { .. } => "COMMIT_OR_RESPONSE_UNCERTAIN_KEEP_ALL_CLAIMS",
        }
    }
    pub(super) fn uncertain(self) -> Self {
        Self::CommitUncertain {
            cause: Box::new(self),
        }
    }
}
fn filesystem_code(error: &StoreError) -> &'static str {
    match error {
        StoreError::DirectoryRecheck { .. } => "DIRECTORY_REBOUND",
        StoreError::Refused(fault) => match fault {
            StoreFault::PrivateFile => "PRIVATE_FILE",
            StoreFault::PrivateDirectory => "PRIVATE_DIRECTORY",
            StoreFault::DirectoryRebound => "DIRECTORY_REBOUND",
            StoreFault::FileRebound => "JOURNAL_REBOUND",
            StoreFault::Changed => "JOURNAL_CHANGED",
            StoreFault::StoreBound => "STORE_BOUND",
            StoreFault::LockRebound => "LOCK_REBOUND",
            StoreFault::TemporaryRebound => "TEMP_REBOUND_KEEP_RAW",
            _ => "LEDGER_UNAVAILABLE",
        },
        StoreError::Finalization { primary, .. } => filesystem_code(primary),
        _ => "LEDGER_UNAVAILABLE",
    }
}
impl From<OperationError> for JournalError {
    fn from(error: OperationError) -> Self {
        Self::Refused(error)
    }
}
impl From<StoreError> for JournalError {
    fn from(error: StoreError) -> Self {
        Self::Filesystem(error)
    }
}
impl fmt::Display for JournalError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.write_str(self.code())
    }
}
impl std::error::Error for JournalError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Refused(e) => Some(e),
            Self::Filesystem(e) => Some(e),
            Self::Finalization { primary, .. } | Self::CommitUncertain { cause: primary } => {
                Some(primary)
            }
        }
    }
}
pub type Result<T> = std::result::Result<T, JournalError>;
pub(super) fn need(value: bool, code: &'static str) -> Result<()> {
    if value {
        Ok(())
    } else {
        Err(JournalError::refusal(code))
    }
}
pub(super) fn finalized<T>(primary: Result<T>, finalizer: Result<()>) -> Result<T> {
    match (primary, finalizer) {
        (Ok(v), Ok(())) => Ok(v),
        (Err(e), Ok(())) | (Ok(_), Err(e)) => Err(e),
        (Err(primary), Err(secondary)) => Err(JournalError::Finalization {
            primary: Box::new(primary),
            secondary: Box::new(secondary),
        }),
    }
}
