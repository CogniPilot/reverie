//! Linux host observations and owned resources. Neither grants owner or
//! admission authority; installing services own their actual effect boundaries.
pub mod broker_engine;
mod captured_client;
pub mod command_telemetry;
pub mod creation_budget;
pub mod deployment_snapshot;
pub mod device_policy;
pub mod embeddings;
pub mod engine_metadata;
pub mod gpu_access;
pub mod host_jobs;
pub mod installed_worker_engine;
pub mod lease_policy;
mod memory_artifacts;
pub mod memory_configuration;
pub mod memory_context;
pub mod memory_instance;
pub mod memory_journal;
pub mod memory_lifecycle;
pub mod memory_mcp;
pub mod memory_namespace;
pub mod memory_profile;
pub mod memory_screen;
mod native;
mod observation;
pub mod office;
pub mod reservation_control;
pub mod reservation_kernel;
pub mod rootless;
pub mod task_perf;
#[cfg(target_os = "linux")]
pub mod terminal_pty;
#[cfg(test)]
mod test_process;
pub mod worker_child;
pub mod worker_identity;
pub mod worker_intent;
pub mod worker_laptop;
pub mod worker_launch;
pub mod worker_mounts;
pub mod worker_nix;
pub mod worker_recovery;
pub mod worker_reports;
pub mod worker_runtime;
pub mod worker_storage;
pub mod worker_validation;

pub use observation::{ObservationError, ObservationFault};
