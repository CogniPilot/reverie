use rusqlite::Connection;
#[derive(Debug)]
pub enum FailureStoreError {
    Refused,
    Unconfirmed,
    Io(std::io::Error),
    Sql(rusqlite::Error),
    Custody(crate::StoreError),
    Identity(crate::storage_identity::IdentityError),
    /// sqlite3_close refused: keep its actual still-owned connection, rather
    /// than turn destructor fallback into a checked cleanup acknowledgement.
    Close(RetainedConnection),
    Finalized {
        primary: Box<Self>,
        secondary: Box<Self>,
    },
}
impl FailureStoreError {
    pub fn is_uncertain(&self) -> bool {
        match self {
            Self::Close(_) | Self::Custody(_) | Self::Unconfirmed => true,
            Self::Finalized { primary, secondary } => {
                primary.is_uncertain() || secondary.is_uncertain()
            }
            _ => false,
        }
    }
}
impl std::fmt::Display for FailureStoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("TELEMETRY_STORE_REFUSED")
    }
}
impl std::error::Error for FailureStoreError {}
impl From<std::io::Error> for FailureStoreError {
    fn from(e: std::io::Error) -> Self {
        Self::Io(e)
    }
}
impl From<rusqlite::Error> for FailureStoreError {
    fn from(e: rusqlite::Error) -> Self {
        Self::Sql(e)
    }
}
impl From<crate::StoreError> for FailureStoreError {
    fn from(e: crate::StoreError) -> Self {
        Self::Custody(e)
    }
}
impl From<crate::storage_identity::IdentityError> for FailureStoreError {
    fn from(e: crate::storage_identity::IdentityError) -> Self {
        Self::Identity(e)
    }
}
pub(super) type Result<T> = std::result::Result<T, FailureStoreError>;
pub(super) fn need(value: bool) -> Result<()> {
    if value {
        Ok(())
    } else {
        Err(FailureStoreError::Refused)
    }
}
pub(super) fn finalized<T>(result: Result<T>, cleanup: Result<()>) -> Result<T> {
    match (result, cleanup) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(error), Ok(())) | (Ok(_), Err(error)) => Err(error),
        (Err(primary), Err(secondary)) => Err(FailureStoreError::Finalized {
            primary: Box::new(primary),
            secondary: Box::new(secondary),
        }),
    }
}

/// Opaque retained native resource after a refused sqlite3_close. There is no
/// SQL/path accessor or implicit checked-close acknowledgement.
#[derive(Debug)]
pub struct RetainedConnection {
    _connection: Box<Connection>,
    _cause: rusqlite::Error,
}
impl RetainedConnection {
    pub(super) fn new(connection: Connection, cause: rusqlite::Error) -> Self {
        Self {
            _connection: Box::new(connection),
            _cause: cause,
        }
    }
}
