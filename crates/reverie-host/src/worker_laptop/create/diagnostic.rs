//! Immutable original completed-client DATA. This supplies no absent-container,
//! retry, cleanup or creation-success authority.
use super::*;
use crate::captured_client::CapturedOutput;
use std::ffi::OsString;

pub struct LaptopCreateDiagnostic {
    arguments: Vec<OsString>,
    output: CapturedOutput,
}
impl LaptopCreateDiagnostic {
    pub(super) fn capture_completed(arguments: Vec<OsString>, output: CapturedOutput) -> Self {
        Self { arguments, output }
    }
    pub fn arguments(&self) -> &[OsString] {
        &self.arguments
    }
    pub fn stdout(&self) -> &[u8] {
        &self.output.stdout
    }
    pub fn stderr(&self) -> &[u8] {
        &self.output.stderr
    }
    pub fn succeeded(&self) -> bool {
        self.output.succeeded
    }
    pub fn shell_code(&self) -> u8 {
        self.output.shell_code
    }
}
impl std::fmt::Debug for LaptopCreateDiagnostic {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LaptopCreateDiagnostic")
            .field("argument_count", &self.arguments.len())
            .field("stdout_bytes", &self.output.stdout.len())
            .field("stderr_bytes", &self.output.stderr.len())
            .field("succeeded", &self.output.succeeded)
            .field("shell_code", &self.output.shell_code)
            .finish()
    }
}
impl LaptopWorkflow {
    /// The SAME completed nonzero create call's original bounded bytes and argv. None
    /// never proves that no attempt/effect occurred. Reading cannot settle or
    /// reset the original workflow, which remains retained on unknown effects.
    pub fn completed_create_diagnostic(&self) -> Result<Option<Arc<LaptopCreateDiagnostic>>> {
        let record = self
            .record
            .try_lock()
            .map_err(|_| LaptopError::Refused("WORKER_LAPTOP_RETAINED"))?;
        Ok(record
            .creation
            .as_ref()
            .and_then(|creation| creation.diagnostic.as_ref())
            .cloned())
    }
}
