//! Reviewed command-failure metadata DATA, never proof of execution or a grant.
use crate::worker_options::{TelemetryKey, WorkerOptionError};
use std::collections::BTreeSet;
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TelemetryConfiguration {
    enabled: bool,
    keys: Vec<TelemetryKey>,
}
impl TelemetryConfiguration {
    pub fn try_new(enabled: bool, keys: Vec<TelemetryKey>) -> Result<Self, WorkerOptionError> {
        if keys.len() > TelemetryKey::ALL.len()
            || enabled && keys.is_empty()
            || keys.iter().collect::<BTreeSet<_>>().len() != keys.len()
        {
            return Err(WorkerOptionError::Telemetry);
        }
        Ok(Self { enabled, keys })
    }
    pub fn enabled(&self) -> bool {
        self.enabled
    }
    pub fn keys(&self) -> &[TelemetryKey] {
        &self.keys
    }
}
/// The source telemetry census deliberately permits abbreviated engine IDs.
/// This is a fixed inspect reference, never a workload/effect identity proof.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TelemetryContainerId(String);
impl TelemetryContainerId {
    pub fn parse(value: &str) -> Result<Self, crate::ValueError> {
        if !(12..=64).contains(&value.len())
            || !value
                .bytes()
                .all(|point| point.is_ascii_digit() || (b'a'..=b'f').contains(&point))
        {
            return Err(crate::ValueError::ContainerId);
        }
        Ok(Self(value.into()))
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Closed persisted/report vocabulary; raw executable strings never enter it.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd)]
pub enum FailureTool {
    Known(TelemetryKey),
    Unknown,
}
impl FailureTool {
    pub fn parse(value: &str) -> Option<Self> {
        if value == "UNKNOWN_COMMAND" {
            Some(Self::Unknown)
        } else {
            TelemetryKey::parse(value).ok().map(Self::Known)
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Known(key) => key.as_str(),
            Self::Unknown => "UNKNOWN_COMMAND",
        }
    }
    pub fn selected(self, keys: &[TelemetryKey]) -> bool {
        match self {
            Self::Known(key) => keys.contains(&key),
            Self::Unknown => true,
        }
    }
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd)]
pub struct FailureExit(i16);
impl FailureExit {
    pub fn try_new(value: i16) -> Option<Self> {
        (value != 0 && (-255..=255).contains(&value)).then_some(Self(value))
    }
    pub fn get(self) -> i16 {
        self.0
    }
    pub fn category(self) -> &'static str {
        if self.0 == 127 {
            "COMMAND_NOT_FOUND"
        } else if self.0 < 0 {
            "SIGNAL"
        } else {
            "NONZERO"
        }
    }
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FailureEvent {
    execution: crate::ids::ProfileSessionId,
    tool: FailureTool,
    exit: FailureExit,
}
impl FailureEvent {
    pub fn new(
        execution: crate::ids::ProfileSessionId,
        tool: FailureTool,
        exit: FailureExit,
    ) -> Self {
        Self {
            execution,
            tool,
            exit,
        }
    }
    pub fn execution(&self) -> &crate::ids::ProfileSessionId {
        &self.execution
    }
    pub fn tool(&self) -> FailureTool {
        self.tool
    }
    pub fn exit(&self) -> FailureExit {
        self.exit
    }
}
pub const FAILURE_ENTRIES: u32 = 2048;
pub const FAILURE_PAGES: u32 = 256;
pub const FAILURE_RETENTION_SECONDS: u64 = 7 * 86400;
pub const FAILURE_CLOCK_MAX: u64 = 1 << 53;
pub const FAILURE_COUNTER_MAX: u32 = 2_147_483_647;
pub const FAILURE_PROVENANCE: &str = "SELF_REPORTED_RESULT";
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FailureCount {
    tool: FailureTool,
    exit: FailureExit,
    count: u32,
}
impl FailureCount {
    pub fn try_new(tool: FailureTool, exit: FailureExit, count: u32) -> Option<Self> {
        (1..=FAILURE_ENTRIES)
            .contains(&count)
            .then_some(Self { tool, exit, count })
    }
    pub fn tool(&self) -> FailureTool {
        self.tool
    }
    pub fn exit(&self) -> FailureExit {
        self.exit
    }
    pub fn count(&self) -> u32 {
        self.count
    }
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FailureReport {
    employee: crate::ids::ProfileEmployeeId,
    counts: Vec<FailureCount>,
    evicted: u32,
    expired: u32,
    dropped: u32,
}
impl FailureReport {
    pub fn new(
        employee: crate::ids::ProfileEmployeeId,
        counts: Vec<FailureCount>,
        evicted: u32,
        expired: u32,
        dropped: u32,
    ) -> Self {
        Self {
            employee,
            counts,
            evicted: evicted.min(FAILURE_COUNTER_MAX),
            expired: expired.min(FAILURE_COUNTER_MAX),
            dropped: dropped.min(FAILURE_COUNTER_MAX),
        }
    }
    pub fn employee(&self) -> &crate::ids::ProfileEmployeeId {
        &self.employee
    }
    pub fn counts(&self) -> &[FailureCount] {
        &self.counts
    }
    pub fn evicted(&self) -> u32 {
        self.evicted
    }
    pub fn expired(&self) -> u32 {
        self.expired
    }
    pub fn dropped(&self) -> u32 {
        self.dropped
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FailureReportRequest(Vec<crate::ids::ProfileEmployeeId>);
impl FailureReportRequest {
    pub fn try_new(employees: Vec<crate::ids::ProfileEmployeeId>) -> Option<Self> {
        (employees.len() <= 64
            && employees.iter().collect::<BTreeSet<_>>().len() == employees.len())
        .then_some(Self(employees))
    }
    pub fn employees(&self) -> &[crate::ids::ProfileEmployeeId] {
        &self.0
    }
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EmployeeFailureReport {
    Unavailable,
    NoData,
    Ready(FailureReport),
}
