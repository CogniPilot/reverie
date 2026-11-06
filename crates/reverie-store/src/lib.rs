//! Existing-schema persistence. Filesystem custody is not owner authorization.
//!
//! These stores create no endpoint, native effect permit, or alternate backend.
//! The installing application supplies an existing private directory, and its
//! admission/authorization checks remain outside this crate.

mod error;
pub mod memory;
pub mod operations;
mod private_fs;
pub mod profiles;
pub mod storage_identity;
mod transaction;
pub mod worker_storage;

pub use error::{StoreError, StoreFault};

#[cfg(test)]
mod faults;
#[cfg(test)]
mod tests;
