//! Checked worker-request and launch preparation DATA. No process permissions.
mod environment;
mod paths;
use crate::python_text;
pub use environment::{EnvironmentKey, WorkerEnvironment};
pub use paths::{AccountSelection, WorkerDirectory};
use std::fmt;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LaunchRuleError {
    WorkerName,
    Directory,
    OutsideGrants,
    Command,
    Environment,
    Terminal,
    Account,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkerName(String);
impl WorkerName {
    pub fn for_session(
        deployment: &str,
        session: &crate::ids::ProfileSessionId,
    ) -> Result<Self, LaunchRuleError> {
        if !crate::worker_schema::name(deployment, 40, false) {
            return Err(LaunchRuleError::WorkerName);
        }
        Ok(Self(format!("{deployment}-agent-{session}")))
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}
/// Only a derived worker name or complete observed container ID. A reference
/// is DATA; no admission/native ownership can be constructed from it.
pub enum ContainerReference<'a> {
    Worker(&'a WorkerName),
    Observed(&'a crate::ids::ContainerId),
}
impl ContainerReference<'_> {
    pub fn as_str(&self) -> &str {
        match self {
            Self::Worker(name) => name.as_str(),
            Self::Observed(id) => id.as_str(),
        }
    }
}
impl fmt::Display for LaunchRuleError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(out, "{self:?}")
    }
}
impl std::error::Error for LaunchRuleError {}

/// Python codepoints are retained, including lone surrogates. Encoding at an
/// eventual OS execution boundary is separate from request validation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkerCommand(Vec<u32>);
impl WorkerCommand {
    pub fn try_new(points: Vec<u32>) -> Result<Self, LaunchRuleError> {
        if points.is_empty() || points.len() > 128 * 1024 || !valid_text(&points) {
            return Err(LaunchRuleError::Command);
        }
        Ok(Self(points))
    }
    pub fn codepoints(&self) -> &[u32] {
        &self.0
    }
}
pub(super) fn valid_text(points: &[u32]) -> bool {
    points.iter().all(|&cp| cp != 0 && cp <= 0x10ffff)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TerminalSize {
    cols: u16,
    rows: u16,
}
impl TerminalSize {
    pub fn try_new(cols: u16, rows: u16) -> Result<Self, LaunchRuleError> {
        if !(1..=1000).contains(&cols) || !(1..=1000).contains(&rows) {
            return Err(LaunchRuleError::Terminal);
        }
        Ok(Self { cols, rows })
    }
    pub fn cols(self) -> u16 {
        self.cols
    }
    pub fn rows(self) -> u16 {
        self.rows
    }
}

/// Legacy employee name -> ASCII hostname label. ID/owner matching is a
/// separate company-data observation; this string grants no identity.
pub fn employee_hostname(name: &[u32], employee_id: &crate::ids::ProfileEmployeeId) -> String {
    let mut label = String::new();
    for point in python_text::lower_codepoints(name) {
        if let Ok(byte) = u8::try_from(point)
            && (byte.is_ascii_lowercase() || byte.is_ascii_digit())
        {
            label.push(char::from(byte));
        } else if !label.is_empty() && !label.ends_with('-') {
            label.push('-');
        }
    }
    let label = label.trim_matches('-');
    let label = label[..label.len().min(48)].trim_matches('-');
    format!(
        "{}-{}",
        if label.is_empty() { "employee" } else { label },
        &employee_id.as_str()[..8]
    )
}
