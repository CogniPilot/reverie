//! Non-destructive retention owners. Old-tree enumeration is not an operation
//! exposed by this module; qualifying subunits alone never release a fence.
pub(in crate::worker_storage::cold_tmp) mod mappings;
mod references;
pub(in crate::worker_storage::cold_tmp) mod scope;
