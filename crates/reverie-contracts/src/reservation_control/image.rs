use super::*;
use crate::legacy_json;
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CurrentImageDataError {
    Json,
    DuplicateKey,
    Stale,
}
impl CurrentImageDataError {
    pub fn code(self) -> &'static str {
        match self {
            Self::Json => "invalid-json",
            Self::DuplicateKey => "duplicate-json-key",
            Self::Stale => "WORKER_IMAGE_CONFIGURATION_STALE",
        }
    }
}
impl fmt::Display for CurrentImageDataError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.write_str(self.code())
    }
}
impl std::error::Error for CurrentImageDataError {}
/// Original capture_current_image data check only. Native file custody and its
/// initial/terminal named stamps remain mandatory and are never supplied here.
pub fn validate_current_image_bytes(
    raw: &[u8],
    config: &EffectiveWorkerConfig,
) -> std::result::Result<(), CurrentImageDataError> {
    CurrentImageData::decode(raw)?.validate(config)
}
/// Parsed strict file data only. Kept separate so the native reader can finish
/// its checked descriptor close before testing the selected image equality.
pub struct CurrentImageData(legacy_json::Value);
impl CurrentImageData {
    pub fn decode(raw: &[u8]) -> std::result::Result<Self, CurrentImageDataError> {
        legacy_json::decode_strict_bytes(raw)
            .map(Self)
            .map_err(|error| match error {
                legacy_json::Error::InvalidJson => CurrentImageDataError::Json,
                legacy_json::Error::DuplicateKey => CurrentImageDataError::DuplicateKey,
            })
    }
    pub fn validate(
        &self,
        config: &EffectiveWorkerConfig,
    ) -> std::result::Result<(), CurrentImageDataError> {
        let current = object(&self.0).map_err(|_| CurrentImageDataError::Stale)?;
        let source = object(config.as_value()).map_err(|_| CurrentImageDataError::Stale)?;
        let expected = source
            .get(&key("image"))
            .ok_or(CurrentImageDataError::Stale)?;
        let matches = current
            .get(&key("image"))
            .map_or(matches!(expected.0, Node::Null), |value| {
                value.python_eq(expected)
            });
        if matches {
            Ok(())
        } else {
            Err(CurrentImageDataError::Stale)
        }
    }
}
