use reverie_core::memory::{EmbeddingError, MemoryMathError};
use std::{fmt, io};
#[derive(Debug)]
pub enum MemoryError {
    Sqlite(rusqlite::Error),
    Io(io::Error),
    Embedding(EmbeddingError),
    Math(MemoryMathError),
    Ranking(reverie_core::memory::MemoryRankError),
    DocumentCodec(reverie_contracts::memory_documents::DocumentCodecError),
    DocumentPolicy(reverie_core::memory_documents::DocumentPolicyError),
    DocumentConflict {
        expected: i64,
        current: i64,
    },
    BallotConflict,
    CoreChangeRequiresVote,
    DocumentContextMismatch,
    Json(reverie_contracts::memory::MemoryJsonError),
    Missing(i64),
    ProtectedBelief(i64),
    EmptyBelief,
    EmptyExternalSource,
    MissingExternalMemory,
    NotDream(i64),
    AmbiguousAssistantColumns,
    MissingAssistantColumn,
    NotInitialized,
    NeedsMigration,
    NeedsProfileRefresh,
    LegacyReadinessCollision,
    ForeignReadinessNamespace,
    MalformedReadinessMetadata,
    UnsupportedReadinessVersion,
    ReadinessRecoveryRequired,
    ReadinessObservationUnavailable(Box<Self>),
    ReadinessChanged,
    ReadinessUnconfirmed,
    /// Failed native constructor with an actual refused-close connection.
    NativeReadPending {
        primary: Box<Self>,
        reader: Box<super::NativeMemoryRead>,
    },
    /// Failed bound read whose actual SQLite connection still needs shutdown.
    ReaderPending {
        primary: Box<Self>,
        reader: Box<super::MemoryReader>,
    },
    Filesystem(crate::StoreError),
    AmbiguousLegacyHistory,
    Closed,
    Poisoned,
    RollbackAfterPanic(Box<Self>),
    ActiveTransaction,
    Integrity,
    SameDatabase,
    EphemeralSnapshot,
    SnapshotTimeout,
    BackupUncertain(Box<Self>),
    RestoreUncertain(Box<Self>),
    Finalization {
        primary: Box<Self>,
        secondary: Box<Self>,
    },
}
impl fmt::Display for MemoryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Sqlite(e) => e.fmt(f),
            Self::Io(e) => e.fmt(f),
            Self::Embedding(e) => e.fmt(f),
            Self::Math(e) => e.fmt(f),
            Self::Ranking(e) => e.fmt(f),
            Self::Json(e) => e.fmt(f),
            Self::Filesystem(e) => e.fmt(f),
            Self::Missing(id) => write!(f, "memory or belief {id} does not exist"),
            Self::ProtectedBelief(id) => write!(
                f,
                "belief {id} is protected and is never removed by the system"
            ),
            Self::Finalization { primary, secondary } => {
                write!(f, "{primary}; finalizer: {secondary}")
            }
            value => write!(f, "{value:?}"),
        }
    }
}
impl std::error::Error for MemoryError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Sqlite(e) => Some(e),
            Self::Io(e) => Some(e),
            Self::Embedding(e) => Some(e),
            Self::Math(e) => Some(e),
            Self::Ranking(e) => Some(e),
            Self::DocumentCodec(e) => Some(e),
            Self::DocumentPolicy(e) => Some(e),
            Self::Json(e) => Some(e),
            Self::Filesystem(e) => Some(e),
            Self::Finalization { primary, .. }
            | Self::NativeReadPending { primary, .. }
            | Self::ReaderPending { primary, .. } => Some(primary),
            Self::BackupUncertain(e)
            | Self::RestoreUncertain(e)
            | Self::RollbackAfterPanic(e)
            | Self::ReadinessObservationUnavailable(e) => Some(e),
            _ => None,
        }
    }
}
impl From<rusqlite::Error> for MemoryError {
    fn from(e: rusqlite::Error) -> Self {
        Self::Sqlite(e)
    }
}
impl From<reverie_contracts::memory_documents::DocumentCodecError> for MemoryError {
    fn from(error: reverie_contracts::memory_documents::DocumentCodecError) -> Self {
        Self::DocumentCodec(error)
    }
}
impl From<reverie_core::memory_documents::DocumentPolicyError> for MemoryError {
    fn from(error: reverie_core::memory_documents::DocumentPolicyError) -> Self {
        Self::DocumentPolicy(error)
    }
}
impl From<io::Error> for MemoryError {
    fn from(e: io::Error) -> Self {
        Self::Io(e)
    }
}
impl From<crate::StoreError> for MemoryError {
    fn from(error: crate::StoreError) -> Self {
        Self::Filesystem(error)
    }
}
impl From<EmbeddingError> for MemoryError {
    fn from(e: EmbeddingError) -> Self {
        Self::Embedding(e)
    }
}
impl From<MemoryMathError> for MemoryError {
    fn from(e: MemoryMathError) -> Self {
        Self::Math(e)
    }
}
impl From<reverie_core::memory::MemoryRankError> for MemoryError {
    fn from(error: reverie_core::memory::MemoryRankError) -> Self {
        Self::Ranking(error)
    }
}
impl From<reverie_contracts::memory::MemoryJsonError> for MemoryError {
    fn from(e: reverie_contracts::memory::MemoryJsonError) -> Self {
        Self::Json(e)
    }
}
pub type Result<T> = std::result::Result<T, MemoryError>;
pub(super) fn finalized<T>(primary: Result<T>, finalizer: Result<()>) -> Result<T> {
    match (primary, finalizer) {
        (Ok(v), Ok(())) => Ok(v),
        (Err(e), Ok(())) | (Ok(_), Err(e)) => Err(e),
        (Err(primary), Err(secondary)) => Err(MemoryError::Finalization {
            primary: Box::new(primary),
            secondary: Box::new(secondary),
        }),
    }
}
