//! Optional worker declarations. Checked data, never host custody or authority.
use crate::{
    operations::{JournalDigest, JournalId},
    posix_path::PosixPath,
};
use std::fmt;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WorkerOptionError {
    Helper,
    Reservation,
    Ops,
    Selector,
    Goal,
    Telemetry,
    Cold,
}
impl fmt::Display for WorkerOptionError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(out, "WORKER_OPTION_{self:?}")
    }
}
impl std::error::Error for WorkerOptionError {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WorkerPathPolicy {
    Helper,
    Reservation,
    Ops,
    Selector,
    Goal,
    Cold,
}
impl WorkerPathPolicy {
    pub fn check(self, value: &[u32]) -> Result<PosixPath, WorkerOptionError> {
        let error = self.refusal();
        let path = PosixPath::try_new(value).map_err(|_| error)?;
        let points = path.codepoints();
        if !path.is_absolute() {
            return Err(error);
        }
        let canonical = self != Self::Selector;
        let single_anchor = matches!(self, Self::Reservation | Self::Ops);
        let no_parent = matches!(self, Self::Reservation | Self::Goal);
        let controls = match self {
            Self::Reservation => value.iter().any(|&c| c < 32),
            Self::Ops => value.iter().any(|&c| c < 32 || c == 127),
            Self::Goal => value.iter().any(|c| [0, 10, 13].contains(c)),
            Self::Cold => value.contains(&0),
            _ => false,
        };
        if canonical && points != value
            || single_anchor && points.starts_with(&[47, 47])
            || no_parent && value.split(|&c| c == 47).any(|p| p == [46, 46])
            || self == Self::Goal && points == [47]
            || controls
        {
            return Err(error);
        }
        Ok(path)
    }
    pub fn refusal(self) -> WorkerOptionError {
        match self {
            Self::Helper => WorkerOptionError::Helper,
            Self::Reservation => WorkerOptionError::Reservation,
            Self::Ops => WorkerOptionError::Ops,
            Self::Selector => WorkerOptionError::Selector,
            Self::Goal => WorkerOptionError::Goal,
            Self::Cold => WorkerOptionError::Cold,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum TelemetryKey {
    Shell,
    Python,
    Git,
    Zip,
}
impl TelemetryKey {
    pub const ALL: [Self; 4] = [Self::Shell, Self::Python, Self::Git, Self::Zip];
    pub fn parse(value: &str) -> Result<Self, WorkerOptionError> {
        match value {
            "shell" => Ok(Self::Shell),
            "python" => Ok(Self::Python),
            "git" => Ok(Self::Git),
            "zip" => Ok(Self::Zip),
            _ => Err(WorkerOptionError::Telemetry),
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Shell => "shell",
            Self::Python => "python",
            Self::Git => "git",
            Self::Zip => "zip",
        }
    }
}

pub struct ReservationOption {
    directory: PosixPath,
    company: JournalId,
    pool: JournalId,
    scope_digest: JournalDigest,
    host_reserve_mib: u32,
}

/// Compatibility wrapper retains worker-purpose diagnostics while the shared
/// published OPS owner validates the identifier grammar once.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OpsServiceId(crate::ops::OpsServiceId);
impl OpsServiceId {
    pub fn parse(value: &str) -> Result<Self, WorkerOptionError> {
        crate::ops::OpsServiceId::parse(value)
            .map(Self)
            .map_err(|_| WorkerOptionError::Ops)
    }
    pub fn as_str(&self) -> &str {
        self.0.as_str()
    }
}
impl ReservationOption {
    pub fn try_new(
        directory: &[u32],
        company: &str,
        pool: &str,
        scope_digest: &str,
        host_reserve_mib: u32,
    ) -> Result<Self, WorkerOptionError> {
        let company = JournalId::parse(company).map_err(|_| WorkerOptionError::Reservation)?;
        let pool = JournalId::parse(pool).map_err(|_| WorkerOptionError::Reservation)?;
        let scope_digest =
            JournalDigest::parse(scope_digest).map_err(|_| WorkerOptionError::Reservation)?;
        if !(1..=1_048_576).contains(&host_reserve_mib) {
            return Err(WorkerOptionError::Reservation);
        }
        Ok(Self {
            directory: WorkerPathPolicy::Reservation.check(directory)?,
            company,
            pool,
            scope_digest,
            host_reserve_mib,
        })
    }
    pub fn directory(&self) -> &PosixPath {
        &self.directory
    }
    pub fn company_id(&self) -> &str {
        self.company.as_str()
    }
    pub fn company(&self) -> &JournalId {
        &self.company
    }
    pub fn pool_id(&self) -> &str {
        self.pool.as_str()
    }
    pub fn pool(&self) -> &JournalId {
        &self.pool
    }
    pub fn owner_scope_digest(&self) -> &str {
        self.scope_digest.as_str()
    }
    pub fn owner_scope(&self) -> &JournalDigest {
        &self.scope_digest
    }
    pub fn host_reserve_mib(&self) -> u32 {
        self.host_reserve_mib
    }
}
