//! Existing owner-selected output-policy data. Patterns confer no permission
//! and do not claim an implemented or compatible regex engine.
use super::*;
pub struct OutputPolicy {
    patterns: Vec<MetadataText>,
}
#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub enum OutputPolicyError {
    Json,
    Fields,
    Patterns,
}
impl std::fmt::Display for OutputPolicyError {
    fn fmt(&self, output: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        output.write_str(match self {
            Self::Json => "output policy JSON refused",
            Self::Fields => "output policy must contain only denied_patterns",
            Self::Patterns => "denied_patterns must be a list of nonempty regex strings",
        })
    }
}
impl std::error::Error for OutputPolicyError {}
impl OutputPolicy {
    pub fn decode(text: PythonTextRef<'_>) -> std::result::Result<Self, OutputPolicyError> {
        let data =
            legacy_json::decode_memory_cli_text(text).map_err(|_| OutputPolicyError::Json)?;
        let Node::Object(fields) = &data.value.0 else {
            return Err(OutputPolicyError::Fields);
        };
        if fields.keys().any(|name| name != &key("denied_patterns")) {
            return Err(OutputPolicyError::Fields);
        }
        let Some(value) = fields.get(&key("denied_patterns")) else {
            return Ok(Self {
                patterns: Vec::new(),
            });
        };
        let Node::Array(patterns) = &value.0 else {
            return Err(OutputPolicyError::Patterns);
        };
        let patterns = patterns
            .iter()
            .map(|value| {
                as_text(value)
                    .filter(|text| !text.codepoints().is_empty())
                    .ok_or(OutputPolicyError::Patterns)
            })
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(Self { patterns })
    }
    pub fn patterns(&self) -> &[MetadataText] {
        &self.patterns
    }
}
