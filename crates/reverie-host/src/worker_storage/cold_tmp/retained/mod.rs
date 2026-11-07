//! Non-destructive retention owners. Old-tree enumeration is not an operation
//! exposed by this module; qualifying subunits alone never release a fence.
#[cfg(test)]
pub(in crate::worker_storage) mod faults;
pub(in crate::worker_storage::cold_tmp) mod finish;
mod held;
pub(in crate::worker_storage::cold_tmp) mod mappings;
pub(in crate::worker_storage::cold_tmp) mod prepare;
pub(in crate::worker_storage::cold_tmp) mod ready;
mod references;
pub(in crate::worker_storage::cold_tmp) mod scope;
