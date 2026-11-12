use super::*;
use crate::{
    legacy_json, worker_config::EffectiveWorkerConfig, worker_image_switch::WorkerImageId,
};
use reverie_core::{device_policy::NvidiaCdiDevice, ids::ProfileEmployeeId};

pub struct PreflightCandidate(EffectiveWorkerConfig);
impl PreflightCandidate {
    pub fn project(
        config: &EffectiveWorkerConfig,
        employee: &ProfileEmployeeId,
        device: &NvidiaCdiDevice,
    ) -> Result<Self> {
        let mut proposed = config.clone();
        proposed
            .patch_preflight_gpu_grant(employee, device)
            .ok_or(GpuDataError::Configuration)?;
        Ok(Self(proposed))
    }
    pub fn configuration(&self) -> &EffectiveWorkerConfig {
        &self.0
    }
}
pub struct PreflightImage(Value);
pub struct PreflightImageLabels(Value);
impl PreflightImage {
    pub fn decode(raw: &[u8], expected: &WorkerImageId) -> Result<Self> {
        let value = legacy_json::decode_loads_bytes(raw).map_err(|_| GpuDataError::Json)?;
        let root = object(&value).ok_or(GpuDataError::NativeBinding)?;
        if !field(root, "Id").is_some_and(|value| value.python_eq(&string(expected.as_str()))) {
            return Err(GpuDataError::NativeBinding);
        }
        Ok(Self(value))
    }
    /// Call after the actual rootless-image observation. A truthy non-map
    /// Labels value is retained until its original later .get operation.
    pub fn labels(&self) -> Result<PreflightImageLabels> {
        let config = object(&self.0)
            .and_then(|root| field(root, "Config"))
            .and_then(object)
            .ok_or(GpuDataError::NativeBinding)?;
        let labels = field(config, "Labels");
        let value = if legacy_json::truthy(labels) {
            labels.expect("truthy existing labels").deep_clone()
        } else {
            Value(Node::Object(Object::new()))
        };
        Ok(PreflightImageLabels(value))
    }
}
impl PreflightImageLabels {
    pub fn browser_profile(&self) -> Result<bool> {
        let labels = object(&self.0).ok_or(GpuDataError::NativeBinding)?;
        Ok(field(labels, "org.reverie.worker.browser")
            .is_some_and(|value| value.python_eq(&string("1"))))
    }
}
