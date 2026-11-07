use reverie_contracts::profiles_v1::CodecError;
use reverie_core::profiles::ProfileError;
use std::fmt;
use std::io;

/// Closed filesystem refusal vocabulary. None of these values grants authority.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StoreFault {
    InvalidPath,
    PrivateDirectory,
    DirectoryRebound,
    PrivateFile,
    FileRebound,
    Changed,
    LockBusy,
    LockRebound,
    StoreBound,
    TemporaryRebound,
    Io,
}
impl StoreFault {
    /// Stable internal diagnostic code without private paths or file contents.
    pub fn code(self) -> &'static str {
        match self {
            Self::InvalidPath => "STORE_PATH",
            Self::PrivateDirectory => "PRIVATE_STORE_DIRECTORY",
            Self::DirectoryRebound => "STORE_DIRECTORY_REBOUND",
            Self::PrivateFile => "PRIVATE_STORE_FILE",
            Self::FileRebound => "STORE_FILE_REBOUND",
            Self::Changed => "STORE_CHANGED",
            Self::LockBusy => "STORE_LOCK_BUSY",
            Self::LockRebound => "LOCK_REBOUND",
            Self::StoreBound => "STORE_BOUND",
            Self::TemporaryRebound => "TEMP_REBOUND_KEEP_RAW",
            Self::Io => "STORE_IO",
        }
    }
}
/// A refusal before publication is distinct from any uncertain publication.
#[derive(Debug)]
pub enum StoreError {
    Refused(StoreFault),
    Io {
        fault: StoreFault,
        source: io::Error,
    },
    Profile(ProfileError),
    Codec(CodecError),
    DirectoryRecheck {
        cause: Box<StoreError>,
    },
    PreparationRetained {
        cause: Box<StoreError>,
    },
    Finalization {
        primary: Box<StoreError>,
        secondary: Box<StoreError>,
    },
    CommitUncertain {
        cause: Box<StoreError>,
    },
    /// The actual owned close was attempted once. This preserves its cause
    /// without changing the separate publication-outcome predicate below.
    CloseUnconfirmed {
        cause: Box<StoreError>,
    },
}
impl StoreError {
    pub(crate) fn io(source: io::Error) -> Self {
        Self::Io {
            fault: StoreFault::Io,
            source,
        }
    }
    pub(crate) fn uncertain(self) -> Self {
        if self.is_uncertain() {
            self
        } else {
            Self::CommitUncertain {
                cause: Box::new(self),
            }
        }
    }
    /// True means inspect retained state; never infer rollback or retry permission.
    pub fn is_uncertain(&self) -> bool {
        matches!(self, Self::CommitUncertain { .. })
    }
    pub(crate) fn unconfirmed_close(self) -> Self {
        Self::CloseUnconfirmed {
            cause: Box::new(self),
        }
    }
    pub(crate) fn has_unconfirmed_close(&self) -> bool {
        match self {
            Self::CloseUnconfirmed { .. } => true,
            Self::Finalization { primary, secondary } => {
                primary.has_unconfirmed_close() || secondary.has_unconfirmed_close()
            }
            Self::DirectoryRecheck { cause }
            | Self::PreparationRetained { cause }
            | Self::CommitUncertain { cause } => cause.has_unconfirmed_close(),
            _ => false,
        }
    }
    /// A code suitable for an application's existing error mapping.
    pub fn code(&self) -> &'static str {
        match self {
            Self::Refused(fault) | Self::Io { fault, .. } => fault.code(),
            Self::Profile(error) => error.code(),
            Self::Codec(error) => error.code(),
            Self::DirectoryRecheck { .. } => StoreFault::DirectoryRebound.code(),
            Self::PreparationRetained { .. } => "STORE_PREPARATION_FAILED_RETAIN_RAW",
            Self::Finalization { .. } => "STORE_FINALIZATION_FAILED_RETAIN_EVIDENCE",
            Self::CommitUncertain { .. } => "COMMIT_OUTCOME_UNCERTAIN_RETAIN_EVIDENCE",
            Self::CloseUnconfirmed { cause } => cause.code(),
        }
    }
}
impl fmt::Display for StoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code())
    }
}
impl std::error::Error for StoreError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io { source, .. } => Some(source),
            Self::CommitUncertain { cause } => Some(cause),
            Self::PreparationRetained { cause } => Some(cause),
            Self::Finalization { primary, .. } => Some(primary),
            Self::DirectoryRecheck { cause } => Some(cause),
            Self::CloseUnconfirmed { cause } => Some(cause),
            _ => None,
        }
    }
}
pub(crate) type Result<T> = std::result::Result<T, StoreError>;
pub(crate) fn need(condition: bool, fault: StoreFault) -> Result<()> {
    if condition {
        Ok(())
    } else {
        Err(StoreError::Refused(fault))
    }
}
pub(crate) fn finalized<T>(primary: Result<T>, finalizer: Result<()>) -> Result<T> {
    match (primary, finalizer) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(error), Ok(())) | (Ok(_), Err(error)) => Err(error),
        (Err(primary), Err(secondary)) => Err(StoreError::Finalization {
            primary: Box::new(primary),
            secondary: Box::new(secondary),
        }),
    }
}
