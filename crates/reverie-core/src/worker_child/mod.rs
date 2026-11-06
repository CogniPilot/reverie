//! Private worker-child environment policy DATA. The post-broker environment
//! is deliberately unrestricted; the public worker request allowlist differs.
mod environment;
mod temporary;
pub use environment::{ChildEnvironment, ChildEnvironmentError, ChildEnvironmentValue};
pub use temporary::TemporaryEnvironmentRoot;

/// Existing fixed guest Office relay origin. Configuration data, not identity.
pub const OFFICE_API_URL: &str = "http://127.0.0.1:8093";
