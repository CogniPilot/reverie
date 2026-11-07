//! Existing memory-document and ballot identities. These values grant no
//! owner permission, self-change approval, native effect or database access.
use crate::PythonText;
pub use crate::persona::DEFAULT_PERSONA;
use std::fmt;
pub const DEFAULT_PLAN: &str = "# Reverie plan\n\nAll experts are persistent AI agents. Roles and permissions are selected explicitly by the owner.\n\n## Priorities\n- Read the room and obtain the current project handoffs before changing assignments.\n- Curate a model-budgeted, task-specific context brief for each worker before dispatch.\n- Keep each project owner, working tree, next action and verification evidence current.\n- Use available subscription workers for bounded tasks; continue locally when exhausted.\n\n## Decisions and blockers\n- Preserve the existing memory database, dreams, reflections, mood and voice.\n- Coordinator appointment in Reverie requires the user's Lead action.\n";
pub fn assignment_byte_budget(
    context_window: u64,
    output_tokens: u64,
    occupied_tokens: u64,
) -> Result<usize, DocumentPolicyError> {
    if !(1024..=10_000_000).contains(&context_window) {
        return Err(DocumentPolicyError);
    }
    Ok(context_window
        .saturating_sub(output_tokens)
        .saturating_sub(occupied_tokens)
        .saturating_sub(2048)
        .min(32_000) as usize)
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DocumentPolicyError;
impl fmt::Display for DocumentPolicyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("MEMORY_DOCUMENT_POLICY")
    }
}
impl std::error::Error for DocumentPolicyError {}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DocumentName(PythonText);
impl DocumentName {
    pub fn from_text(value: PythonText) -> Self {
        Self(value)
    }
    pub fn from_scalar_text(value: &str) -> Self {
        Self(PythonText::from_scalar_text(value))
    }
    pub fn text(&self) -> &PythonText {
        &self.0
    }
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DocumentRevision(i64);
impl DocumentRevision {
    pub fn try_new(value: i64) -> Result<Self, DocumentPolicyError> {
        if value < 0 {
            Err(DocumentPolicyError)
        } else {
            Ok(Self(value))
        }
    }
    pub fn value(self) -> i64 {
        self.0
    }
    pub fn next(self) -> Result<Self, DocumentPolicyError> {
        self.0.checked_add(1).map(Self).ok_or(DocumentPolicyError)
    }
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DeveloperName(String);
impl DeveloperName {
    pub fn parse(value: &str) -> Result<Self, DocumentPolicyError> {
        if value.is_empty()
            || value.len() > 64
            || !value.as_bytes()[0].is_ascii_lowercase()
            || !value
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
        {
            return Err(DocumentPolicyError);
        }
        Ok(Self(value.to_owned()))
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BallotCategory(String);
impl BallotCategory {
    pub fn parse(value: &str) -> Result<Self, DocumentPolicyError> {
        let attribute = value.strip_prefix("attribute:").is_some_and(|v| {
            !v.is_empty()
                && v.len() <= 80
                && v.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'.' || b == b'-')
        });
        if !["core", "vacation", "publication"].contains(&value) && !attribute {
            return Err(DocumentPolicyError);
        }
        Ok(Self(value.to_owned()))
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}
/// Python float // week boundaries, including pre-epoch instants. Production
/// ballot stores obtain their own clock; this pure result is data only.
pub fn ballot_week(now: f64) -> Result<i64, DocumentPolicyError> {
    let value = now - 345600.0;
    let remainder = value % 604800.0;
    let mut divided = (value - remainder) / 604800.0;
    if remainder < 0.0 {
        divided -= 1.0;
    }
    let mut rounded = divided.floor();
    if divided - rounded > 0.5 {
        rounded += 1.0;
    }
    if !rounded.is_finite() || rounded < i64::MIN as f64 || rounded >= -(i64::MIN as f64) {
        return Err(DocumentPolicyError);
    }
    Ok(rounded as i64)
}
