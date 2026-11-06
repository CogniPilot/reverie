//! Fixed in-worker record/environment/exec lifecycle. No host engine endpoint,
//! owner permission, resource admission or generic host-command interface.
mod directory;
mod error;
mod process;
mod receipt;
mod record;
mod runtime;
pub use error::{ChildCause, ChildCleanup, ChildError, ChildPhase, RecordDisposition};
pub use runtime::WorkerChildRuntime;
#[cfg(test)]
mod test_hooks;
#[cfg(test)]
mod tests;
