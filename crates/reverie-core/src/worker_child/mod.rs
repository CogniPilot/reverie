//! Private worker-child environment policy DATA. The post-broker environment
//! is deliberately unrestricted; the public worker request allowlist differs.
mod environment;
mod temporary;
pub use environment::{ChildEnvironment, ChildEnvironmentError, ChildEnvironmentValue};
pub use temporary::TemporaryEnvironmentRoot;

/// Existing fixed guest Office relay origin. Configuration data, not identity.
pub const OFFICE_API_URL: &str = "http://127.0.0.1:8093";

/// Fixed guest locations shared by the real broker producer and guest reader.
/// Neither path is host filesystem authority or a request-selected program.
pub const LAUNCH_DIRECTORY: &str = "/home/agent/.reverie-launch";
pub const CHILD_PROGRAM: &str = "/bin/reverie-worker-child";
