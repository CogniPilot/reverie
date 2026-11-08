//! Image-only offline maintenance DATA. These values grant no filesystem,
//! engine, admission, service or human-owner operation authority.
mod deployment;
mod pin;
mod transition;
pub use deployment::DeploymentCompanyData;
pub use pin::WorkerImageId;
use std::fmt;
pub use transition::ImagePinTransition;
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ImageDataError {
    Bound,
    Json,
    Image,
    Changed,
    Span,
}
impl ImageDataError {
    pub fn code(self) -> &'static str {
        match self {
            Self::Bound => "WORKER_IMAGE_CONFIGURATION_BOUND",
            Self::Json => "WORKER_IMAGE_CONFIGURATION_JSON",
            Self::Image => "WORKER_IMAGE_EXACT_PIN_REQUIRED",
            Self::Changed => "WORKER_IMAGE_CONFIGURATION_CHANGED",
            Self::Span => "WORKER_IMAGE_TOKEN_SPAN",
        }
    }
}
impl fmt::Display for ImageDataError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.write_str(self.code())
    }
}
impl std::error::Error for ImageDataError {}
#[cfg(test)]
mod tests;
