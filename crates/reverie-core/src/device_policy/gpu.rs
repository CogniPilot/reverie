use super::DevicePolicyError;
use crate::ids::{ProfileEmployeeId, ProfileSessionId};
use std::collections::BTreeMap;

pub const MAX_GPU_GRANTS: usize = 32;
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NvidiaCdiDevice(String);
impl NvidiaCdiDevice {
    pub fn parse(value: &str) -> Result<Self, DevicePolicyError> {
        let Some(uuid) = value.strip_prefix("nvidia.com/gpu=GPU-") else {
            return Err(DevicePolicyError::GpuDevice);
        };
        if uuid.len() != 36
            || !uuid.bytes().enumerate().all(|(i, b)| {
                if [8, 13, 18, 23].contains(&i) {
                    b == b'-'
                } else {
                    b.is_ascii_hexdigit()
                }
            })
        {
            return Err(DevicePolicyError::GpuDevice);
        }
        Ok(Self(value.into()))
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}
pub type GpuSessionGrants = BTreeMap<ProfileSessionId, NvidiaCdiDevice>;
pub type GpuEmployeeGrants = BTreeMap<ProfileEmployeeId, NvidiaCdiDevice>;
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GpuPolicies {
    legacy: Option<GpuSessionGrants>,
    employees: GpuEmployeeGrants,
}
impl GpuPolicies {
    /// None preserves absence of the legacy gpuGrants key; Some(empty) preserves
    /// its explicit empty shape. Employee and legacy entries count separately.
    pub fn try_new(
        legacy: Option<GpuSessionGrants>,
        employees: GpuEmployeeGrants,
    ) -> Result<Self, DevicePolicyError> {
        if legacy.as_ref().map_or(0, BTreeMap::len) + employees.len() > MAX_GPU_GRANTS {
            return Err(DevicePolicyError::GpuCount);
        }
        Ok(Self { legacy, employees })
    }
    pub fn legacy(&self) -> Option<&GpuSessionGrants> {
        self.legacy.as_ref()
    }
    pub fn employees(&self) -> &GpuEmployeeGrants {
        &self.employees
    }
    pub fn needs_current_employee(&self, session: &ProfileSessionId) -> bool {
        !self.employees.is_empty()
            && !self
                .legacy
                .as_ref()
                .is_some_and(|legacy| legacy.contains_key(session))
    }
    /// Pure projection using current identity data supplied by the native reader.
    /// An EID is not a grant and this function performs no lookup or host effect.
    pub fn project(
        &self,
        session: &ProfileSessionId,
        current: Option<&ProfileEmployeeId>,
    ) -> Option<GpuSessionGrants> {
        if !self.needs_current_employee(session) {
            return self.legacy.clone();
        }
        let selected = current.and_then(|employee| self.employees.get(employee));
        let Some(device) = selected else {
            return self.legacy.clone();
        };
        let mut result = self.legacy.clone().unwrap_or_default();
        result.insert(session.clone(), device.clone());
        Some(result)
    }
    pub fn create_args(
        &self,
        session: &ProfileSessionId,
        current: Option<&ProfileEmployeeId>,
    ) -> Vec<String> {
        let grants = self.project(session, current);
        let Some(device) = grants.as_ref().and_then(|grants| grants.get(session)) else {
            return Vec::new();
        };
        vec![
            "--device".into(),
            device.as_str().into(),
            "--env".into(),
            "LD_LIBRARY_PATH=/usr/local/nvidia/lib64:/usr/local/nvidia/lib".into(),
        ]
    }
}
