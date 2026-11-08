use super::ImageDataError;
use reverie_core::operations::JournalDigest;
/// Immutable SHA256 image identity DATA. Existence, full image specification,
/// child ABI and permission remain the actual native maintenance owner's work.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkerImageId(String);
impl WorkerImageId {
    pub fn parse(value: &str) -> Result<Self, ImageDataError> {
        let digest = value.strip_prefix("sha256:").ok_or(ImageDataError::Image)?;
        JournalDigest::parse(digest).map_err(|_| ImageDataError::Image)?;
        Ok(Self(value.to_owned()))
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}
