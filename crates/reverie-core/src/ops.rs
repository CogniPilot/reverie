//! Existing OPS company/resource vocabulary. These values are references,
//! never authorization, ownership or permission to execute an operation.
use std::fmt;
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct OpsIdentifierError;
impl fmt::Display for OpsIdentifierError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.write_str("OPS_IDENTIFIER")
    }
}
impl std::error::Error for OpsIdentifierError {}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OpsServiceId(String);
impl OpsServiceId {
    pub fn parse(value: &str) -> Result<Self, OpsIdentifierError> {
        if value.is_empty()
            || value.len() > 96
            || value.as_bytes()[0] == b'-'
            || !value
                .bytes()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
        {
            return Err(OpsIdentifierError);
        }
        Ok(Self(value.to_owned()))
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}
