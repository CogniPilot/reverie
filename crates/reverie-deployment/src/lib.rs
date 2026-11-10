//! Registered console deployment application service. Its CLI and future HTTP
//! adapter share these operations; no request supplies engine argv or a shell.
mod binds;
mod engine;
mod error;
pub use error::DeploymentError;
mod installation;
mod model;
#[cfg(test)]
mod native_fixture;
mod operation;
mod pins;
mod rollout;
mod service;
pub use model::{DeploymentPreview, DeploymentProfile, DeploymentStatus};
pub use rollout::{
    InitialWebsiteRolloutClosed, InitialWebsiteRolloutError, InitialWebsiteRolloutFailure,
    rollout_initial_website,
};
pub use service::DeploymentService;
type Result<T> = std::result::Result<T, DeploymentError>;
fn require(value: bool, code: &'static str) -> Result<()> {
    if value {
        Ok(())
    } else {
        Err(DeploymentError::new(code))
    }
}
