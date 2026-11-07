//! Registered console deployment application service. Its CLI and future HTTP
//! adapter share these operations; no request supplies engine argv or a shell.
mod binds;
mod engine;
mod installation;
mod model;
#[cfg(test)]
mod native_fixture;
mod operation;
mod pins;
mod service;
pub use model::{DeploymentPreview, DeploymentStatus};
pub use service::DeploymentService;
use std::{fmt, io};

#[derive(Debug)]
pub struct DeploymentError {
    code: &'static str,
    secondary: Option<&'static str>,
}
impl DeploymentError {
    fn new(code: &'static str) -> Self {
        Self {
            code,
            secondary: None,
        }
    }
    pub fn code(&self) -> &'static str {
        self.code
    }
    pub fn finalization_code(&self) -> Option<&'static str> {
        self.secondary
    }
    fn finalized<T>(result: Result<T>, cleanup: Result<()>) -> Result<T> {
        match (result, cleanup) {
            (Ok(value), Ok(())) => Ok(value),
            (Err(error), Ok(())) | (Ok(_), Err(error)) => Err(error),
            (Err(mut primary), Err(secondary)) => {
                primary.secondary = Some(secondary.code);
                Err(primary)
            }
        }
    }
}
impl fmt::Display for DeploymentError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.write_str(self.code)
    }
}
impl std::error::Error for DeploymentError {}
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
type Result<T> = std::result::Result<T, DeploymentError>;
fn require(value: bool, code: &'static str) -> Result<()> {
    if value {
        Ok(())
    } else {
        Err(DeploymentError::new(code))
    }
}
