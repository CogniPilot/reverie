//! Closed host-resume DATA formats. These codecs grant no website, employee,
//! process, native-running, maintenance, operation or replay authority.
mod build;
mod protocol;
mod recipe;
pub use build::{
    MAX_PROGRAM_BYTES, MAX_PROGRAM_ENTRIES, MAX_PROGRAM_FILE_BYTES, MAX_PROGRAM_MANIFEST_BYTES,
    PROGRAM_PURPOSE, ResumeProgramBuild,
};
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
    crate::human_protocol::finite(name).map_err(|error| ResumeDataError(error.code()))
}
