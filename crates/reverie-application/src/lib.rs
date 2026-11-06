//! Application workflows over the same contracts, stores and native adapters.
//! Callers retain owner authorization, whole worker-domain validation and native
//! admission/effect custody. Returned candidates do not establish those powers.
pub mod memory_import;
pub mod memory_recall;
pub mod memory_startup;
pub mod project_memory;
pub mod reservation_gate;
pub mod reservation_observer;
pub mod resource_staging;
pub mod worker_launch;
pub mod worker_validation;
