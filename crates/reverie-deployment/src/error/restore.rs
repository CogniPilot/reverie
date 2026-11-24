//! What became of the original console after a failed apply had stopped it.
use super::DeploymentError;
use serde_json::{Value, json};

/// The result of bringing the original console back. An update that fails is
/// still a failure; this says whether the office is serving again.
pub enum SourceRestore {
    /// The original console is running, answered its readiness check and the
    /// operation is recorded as restored.
    Restored,
    /// No restore effect was issued. The rollback attempt is still available.
    NotAttempted(DeploymentError),
    /// The one rollback attempt was used and its result is not proven.
    Unproven(DeploymentError),
}
impl SourceRestore {
    pub fn outcome(&self) -> &'static str {
        match self {
            Self::Restored => "RESTORED",
            Self::NotAttempted(_) => "NOT_ATTEMPTED",
            Self::Unproven(_) => "UNPROVEN",
        }
    }
    /// Why the restore was not attempted or not proven.
    pub fn cause(&self) -> Option<&DeploymentError> {
        match self {
            Self::Restored => None,
            Self::NotAttempted(cause) | Self::Unproven(cause) => Some(cause),
        }
    }
    /// Static codes only, like every other deployment diagnostic.
    pub fn report(&self) -> Value {
        json!({
            "outcome":self.outcome(),
            "officeRestored":matches!(self, Self::Restored),
            "code":self.cause().map(DeploymentError::code),
            "diagnostic":self.cause().map(DeploymentError::diagnostic),
        })
    }
}
