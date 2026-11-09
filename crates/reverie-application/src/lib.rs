//! Application workflows over the same contracts, stores and native adapters.
//! Callers retain owner authorization, whole worker-domain validation and native
//! admission/effect custody. Returned candidates do not establish those powers.
pub mod broker_service;
pub mod installing_broker;
pub use installing_broker::resource_actor;
pub mod memory_import;
pub mod memory_lifecycle;
pub mod memory_recall;
pub mod memory_startup;
pub mod project_memory;
pub mod reservation_gate;
pub mod reservation_observer;
pub mod resource_staging;
#[cfg(test)]
mod test_process;
pub mod worker_inventory;
pub mod worker_launch;
pub mod worker_recovery;
pub mod worker_validation;
