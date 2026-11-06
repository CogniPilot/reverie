//! Named legacy wire codecs. Decoded values and digests confer no authority.
pub mod broker_resources;
pub mod device_policy;
mod digest;
pub mod js_json;
pub mod lease_policy;
mod legacy_json;
pub mod profiles_v1;
pub mod resource_config;
pub mod rootless;
pub mod route_frames_v1;
pub mod route_frames_v2;
pub mod settings_v1;
pub mod storage_identity;
pub mod subscription_profiles_v1;
pub mod task_perf_v1;
pub mod worker_config;
pub mod worker_schema;
