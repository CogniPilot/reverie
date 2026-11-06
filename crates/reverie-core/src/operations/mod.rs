//! Closed journal data and transitions. None of these values is native authority.
mod data;
mod document;
mod operation;
pub use data::*;
pub use document::{OperationDocument, OperationDocumentBuilder};
pub use operation::{
    Effect, Operation, OperationData, OperationState, validate_binding, validate_delta,
    validate_phase_shape, validate_roles,
};
use std::fmt;
pub const MAX_OPERATIONS: usize = 256;
pub const MIB: u64 = 1_048_576;
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct OperationError(&'static str);
impl OperationError {
    pub const fn new(code: &'static str) -> Self {
        Self(code)
    }
    pub fn code(self) -> &'static str {
        self.0
    }
}
impl fmt::Display for OperationError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.write_str(self.0)
    }
}
impl std::error::Error for OperationError {}
pub type Result<T> = std::result::Result<T, OperationError>;
pub(super) fn need(value: bool, code: &'static str) -> Result<()> {
    if value {
        Ok(())
    } else {
        Err(OperationError::new(code))
    }
}
