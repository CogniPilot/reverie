//! Standalone preflight DATA. Its current-generation and report contracts are
//! distinct from the GPU queue: these facts authorize no grant or mutation.
mod current;
use super::*;
pub use current::{PreflightBinding, PreflightSelection};
