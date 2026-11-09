//! Linux host observations and owned resources. Neither grants owner or
//! admission authority; installing services own their actual effect boundaries.
pub mod broker_engine;
pub mod broker_listener;
mod captured_client;
pub mod chat_images;
pub mod command_telemetry;
pub mod creation_budget;
pub mod deployment_snapshot;
pub mod device_policy;
pub mod embeddings;
pub mod engine_metadata;
pub mod goal_custody;
pub mod gpu_access;
pub mod host_jobs;
pub mod installed_worker_engine;
pub mod lease;
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
mod private_pending;
pub mod reservation_control;
pub mod reservation_kernel;
pub mod resource_facts;
pub mod rootless;
pub mod task_perf;
pub mod task_workspace;
#[cfg(target_os = "linux")]
pub mod terminal_pty;
#[cfg(test)]
mod test_docker;
#[cfg(test)]
mod test_process;
pub mod website_facts;
pub mod worker_child;
pub mod worker_identity;
pub mod worker_image;
#[cfg(all(test, target_os = "linux"))]
mod worker_init_tests;
pub mod worker_intent;
pub mod worker_laptop;
pub mod worker_launch;
pub mod worker_mounts;
pub mod worker_nix;
pub mod worker_pool;
pub mod worker_recovery;
pub mod worker_reports;
pub mod worker_runtime;
pub mod worker_source_stop;
pub mod worker_storage;
pub mod worker_validation;

pub use observation::{ObservationError, ObservationFault};

pub mod worker_service;
