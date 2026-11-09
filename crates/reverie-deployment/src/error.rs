use super::Result;
use reverie_host::deployment_snapshot::SnapshotError;
use std::{fmt, io};
mod diagnostic;
mod receipt;
pub(crate) use receipt::decode_receipt;
#[cfg(test)]
mod tests;

pub struct DeploymentError {
    code: &'static str,
    snapshot: Option<Box<SnapshotError>>,
    finalizers: Vec<DeploymentError>,
}
impl DeploymentError {
    pub(crate) fn new(code: &'static str) -> Self {
        Self {
            code,
            snapshot: None,
            finalizers: Vec::new(),
        }
    }
    pub(crate) fn snapshot(code: &'static str, cause: SnapshotError) -> Self {
        Self {
            code,
            snapshot: Some(Box::new(cause)),
            finalizers: Vec::new(),
        }
    }
    pub fn snapshot_error(&self) -> Option<&SnapshotError> {
        self.snapshot.as_deref()
    }
    pub fn finalization_errors(&self) -> &[DeploymentError] {
        &self.finalizers
    }
    pub fn diagnostic(&self) -> serde_json::Value {
        diagnostic::project(self)
    }
    pub fn code(&self) -> &'static str {
        self.code
    }
    pub fn finalization_code(&self) -> Option<&'static str> {
        self.finalizers.last().map(Self::code)
    }
    pub(crate) fn with_finalizer(mut self, finalizer: Self) -> Self {
        self.finalizers.push(finalizer);
        self
    }
    pub(crate) fn has_snapshot(&self) -> bool {
        self.snapshot.is_some() || self.finalizers.iter().any(Self::has_snapshot)
    }
    /// Preserve the operation error together with its checked finalizer error.
    pub fn finalized<T>(result: Result<T>, cleanup: Result<()>) -> Result<T> {
        match (result, cleanup) {
            (Ok(value), Ok(())) => Ok(value),
            (Err(error), Ok(())) | (Ok(_), Err(error)) => Err(error),
            (Err(primary), Err(secondary)) => Err(primary.with_finalizer(secondary)),
        }
    }
}
impl fmt::Display for DeploymentError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.write_str(self.code)
    }
}
impl fmt::Debug for DeploymentError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.debug_struct("DeploymentError")
            .field("code", &self.code)
            .field(
                "snapshot_code",
                &self.snapshot_error().map(SnapshotError::code),
            )
            .field("finalization_count", &self.finalizers.len())
            .finish()
    }
}
impl std::error::Error for DeploymentError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        self.snapshot_error().map(|cause| cause as _)
    }
}
impl From<io::Error> for DeploymentError {
    fn from(_: io::Error) -> Self {
        Self::new("DEPLOYMENT_IO_UNAVAILABLE")
    }
}
impl From<serde_json::Error> for DeploymentError {
    fn from(_: serde_json::Error) -> Self {
        Self::new("DEPLOYMENT_JSON_INVALID")
    }
}
