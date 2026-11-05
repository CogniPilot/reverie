//! Application workflows over the same contracts, stores and native adapters.
//! Callers retain owner authorization, whole worker-domain validation and native
//! admission/effect custody. Returned candidates do not establish those powers.
pub mod resource_staging;
