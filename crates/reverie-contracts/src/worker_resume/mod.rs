//! Closed host-resume DATA formats. These codecs grant no website, employee,
//! process, native-running, maintenance, operation or replay authority.
mod protocol;
mod recipe;
#[cfg(test)]
mod tests;
use crate::legacy_json::{self, Node, Text, Value};
pub use protocol::ResumeFrame;
pub use recipe::recipe_digest;
use std::{collections::BTreeMap, fmt};
pub const PURPOSE: &str = "host-worker-resume-v1";
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ResumeDataError(&'static str);
impl ResumeDataError {
    pub fn code(self) -> &'static str {
        self.0
    }
}
impl fmt::Display for ResumeDataError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.write_str(self.0)
    }
}
impl std::error::Error for ResumeDataError {}
pub type Result<T> = std::result::Result<T, ResumeDataError>;
fn need(ok: bool, code: &'static str) -> Result<()> {
    if ok {
        Ok(())
    } else {
        Err(ResumeDataError(code))
    }
}
fn key(name: &str) -> Text {
    Text(name.bytes().map(u32::from).collect())
}
fn object<'a>(value: &'a Value, code: &'static str) -> Result<&'a BTreeMap<Text, Value>> {
    match &value.0 {
        Node::Object(fields) => Ok(fields),
        _ => Err(ResumeDataError(code)),
    }
}
fn field<'a>(fields: &'a BTreeMap<Text, Value>, name: &str) -> Option<&'a Value> {
    fields.get(&key(name))
}
fn finite(name: Option<&str>) -> Result<()> {
    match name {
        None => Ok(()),
        Some("-inf") => Err(ResumeDataError(
            "Out of range float values are not JSON compliant: -inf",
        )),
        Some("inf") => Err(ResumeDataError(
            "Out of range float values are not JSON compliant: inf",
        )),
        Some(_) => Err(ResumeDataError(
            "Out of range float values are not JSON compliant: nan",
        )),
    }
}
