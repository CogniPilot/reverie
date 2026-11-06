//! Fixed engine name DATA derived from checked installing worker configuration.
//! It is neither positive native ownership nor permission to start/attach.
use crate::{ids::ProfileSessionId, worker_schema::WorkerBase};
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkerContainerName(String);
impl WorkerContainerName {
    pub fn for_session(base: &WorkerBase, session: &ProfileSessionId) -> Self {
        Self(format!("{}-agent-{}", base.deployment(), session.as_str()))
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}
