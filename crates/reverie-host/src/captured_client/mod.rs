//! Private shared capture/settlement machinery. Closed purpose wrappers own
//! command selection and authorization; this module supplies no wire endpoint,
//! engine permit, session grant or successful effect receipt.
mod bootstrap;
mod control;
mod error;
mod process;
#[cfg(test)]
pub(crate) mod test_hooks;
use crate::native::owned_process as native;
pub(crate) use bootstrap::InstalledCommand;
pub use control::CancellationToken;
pub(crate) use control::CapturedClient;
pub use error::CleanupFault;
pub(crate) use error::{Error, Fault};
pub(crate) type Result<T> = std::result::Result<T, Error>;
#[derive(Clone, Copy)]
pub(crate) struct Policy {
    pub(crate) maximum: std::time::Duration,
    pub(crate) maximum_output: usize,
    pub(crate) successful_exit: bool,
}
pub(crate) struct CapturedOutput {
    pub(crate) stdout: Vec<u8>,
    pub(crate) stderr: Vec<u8>,
    pub(crate) succeeded: bool,
}
