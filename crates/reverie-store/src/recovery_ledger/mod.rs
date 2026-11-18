//! Private version-one SQLite recovery ledger. Receipts carry evidence only.
mod contract;
mod custody;
mod journal;
mod operations;
mod receipt;
#[cfg(test)]
mod tests;
mod validate;

pub use contract::Request;
pub use receipt::Response;

use contract::{Operation, usable_clock};
use custody::Custody;
use rusqlite::{Connection, TransactionBehavior};
use std::{fmt, path::Path};
use validate::History;

const WINDOW_MS: i64 = 30 * 60 * 1000;
type Result<T> = std::result::Result<T, Error>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    InputInvalid,
    TransitionInvalid,
    CustodyInvalid,
    StoreUnavailable,
    ClockReversed,
    IdempotencyConflict,
    UnresolvedAttempt,
    QueueFull,
    StoreFull,
    BindingChanged,
    CasStale,
}

impl Error {
    fn semantic(self) -> bool {
        matches!(
            self,
            Self::IdempotencyConflict
                | Self::UnresolvedAttempt
                | Self::QueueFull
                | Self::StoreFull
                | Self::BindingChanged
                | Self::CasStale
        )
    }
}

impl fmt::Display for Error {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InputInvalid => "INPUT_INVALID",
            Self::TransitionInvalid => "TRANSITION_INVALID",
            Self::CustodyInvalid => "CUSTODY_INVALID",
            Self::StoreUnavailable => "STORE_UNAVAILABLE",
            Self::ClockReversed => "CLOCK_REVERSED",
            Self::IdempotencyConflict => "IDEMPOTENCY_CONFLICT",
            Self::UnresolvedAttempt => "UNRESOLVED_ATTEMPT",
            Self::QueueFull => "QUEUE_FULL",
            Self::StoreFull => "STORE_FULL",
            Self::BindingChanged => "BINDING_CHANGED",
            Self::CasStale => "CAS_STALE",
        })
    }
}

impl std::error::Error for Error {}

impl From<rusqlite::Error> for Error {
    fn from(_: rusqlite::Error) -> Self {
        Self::StoreUnavailable
    }
}

impl From<serde_json::Error> for Error {
    fn from(_: serde_json::Error) -> Self {
        Self::StoreUnavailable
    }
}

fn require(condition: bool, error: Error) -> Result<()> {
    condition.then_some(()).ok_or(error)
}

pub struct Ledger {
    db: Connection,
    custody: Custody,
}

impl Ledger {
    /// Open an explicit database in an existing private service directory.
    pub fn open(path: &Path) -> Result<Self> {
        let (custody, db) = Custody::open(path)?;
        validate::version(&db)?;
        custody.check()?;
        Ok(Self { db, custody })
    }

    /// Execute an operation using a timestamp supplied by the trusted caller.
    pub fn execute(&mut self, request: Request) -> Result<Response> {
        let reply = match request.0 {
            Operation::Reserve(input) => {
                input.binding.validate(&input.key)?;
                self.transact(input.now, |db, history| {
                    operations::reserve(db, history, input)
                })
            }
            Operation::Advance(input) => {
                input.validate()?;
                self.transact(input.now, |db, history| {
                    operations::advance(db, history, input)
                })
            }
            Operation::Restart(input) => self.transact(input.now, |db, history| {
                operations::restart(db, history, input.now)
            }),
        }?;
        Ok(Response(reply))
    }

    pub fn close(self) -> Result<()> {
        let db = self.db.close().map_err(|_| Error::StoreUnavailable);
        let custody = self.custody.close();
        db.and(custody)
    }

    fn transact<T>(
        &mut self,
        now: i64,
        operation: impl FnOnce(&Connection, &History) -> Result<T>,
    ) -> Result<T> {
        require(usable_clock(now), Error::InputInvalid)?;
        self.custody.check()?;
        let transaction = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let history = validate::load(&transaction)?;
        require(now >= history.floor, Error::ClockReversed)?;
        transaction.execute("UPDATE ledger_meta SET clock_floor=?", [now])?;
        transaction.execute_batch("SAVEPOINT operation")?;
        let result = operation(&transaction, &history);
        if let Err(error) = result {
            require(error.semantic(), error)?;
            transaction.execute_batch("ROLLBACK TO operation; RELEASE operation")?;
        }
        self.custody.check()?;
        transaction.commit()?;
        result
    }
}
