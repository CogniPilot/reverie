//! Private worker-child environment policy DATA. The post-broker environment
//! is deliberately unrestricted; the public worker request allowlist differs.
mod environment;
mod temporary;
pub use environment::{ChildEnvironment, ChildEnvironmentError, ChildEnvironmentValue};
pub use temporary::TemporaryEnvironmentRoot;
