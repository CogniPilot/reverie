//! Fixed engine name DATA derived from checked installing worker configuration.
//! It is neither positive native ownership nor permission to start/attach.
use crate::{ids::ProfileSessionId, worker_schema::WorkerBase};
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkerContainerName(String);
impl WorkerContainerName {
    /// Convert an already checked launch name. This is name DATA, not a new
    /// observation, resource owner or permission to stop the named container.
    pub fn from_launch_name_data(name: &crate::worker_launch::WorkerName) -> Self {
        Self(name.as_str().to_owned())
    }
    /// Legacy recovery membership DATA. Python removeprefix also accepts a
    /// bare canonical session name; the actual raw name must remain intact.
    /// This supplies no CID/process identity or permission to an effect.
    pub fn from_recovered_name_data(
        base: &WorkerBase,
        name: &str,
    ) -> Option<(ProfileSessionId, Self)> {
        let prefix = format!("{}-agent-", base.deployment());
        let session = ProfileSessionId::parse(name.strip_prefix(&prefix).unwrap_or(name)).ok()?;
        Some((session, Self(name.to_owned())))
    }
    pub fn for_session(base: &WorkerBase, session: &ProfileSessionId) -> Self {
        Self(format!("{}-agent-{}", base.deployment(), session.as_str()))
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}
