//! Owner-selected legacy instance labels. Roles and kinds are metadata, not
//! permission, employment binding or namespace custody.
use std::fmt;
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InstancePolicyError;
impl fmt::Display for InstancePolicyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("MEMORY_INSTANCE")
    }
}
impl std::error::Error for InstancePolicyError {}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InstanceId(String);
impl InstanceId {
    pub fn parse(value: &str) -> Result<Self, InstancePolicyError> {
        if value.is_empty()
            || value.len() > 64
            || !value.as_bytes()[0].is_ascii_alphanumeric()
            || !value
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        {
            return Err(InstancePolicyError);
        }
        Ok(Self(value.to_owned()))
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum InstanceKind {
    Cto,
    Agent,
    Expert,
    Implementer,
}
impl InstanceKind {
    pub fn parse(value: &str) -> Result<Self, InstancePolicyError> {
        match value {
            "cto" => Ok(Self::Cto),
            "agent" => Ok(Self::Agent),
            "expert" => Ok(Self::Expert),
            "implementer" => Ok(Self::Implementer),
            _ => Err(InstancePolicyError),
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Cto => "cto",
            Self::Agent => "agent",
            Self::Expert => "expert",
            Self::Implementer => "implementer",
        }
    }
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SharedRoomTone {
    Professional,
    Social,
}
impl SharedRoomTone {
    pub fn parse(value: &str) -> Result<Self, InstancePolicyError> {
        match value {
            "professional" => Ok(Self::Professional),
            "social" => Ok(Self::Social),
            _ => Err(InstancePolicyError),
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Professional => "professional",
            Self::Social => "social",
        }
    }
}
