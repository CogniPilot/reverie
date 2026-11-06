use super::GpuDeviceUuid;
use crate::{
    device_policy::GpuPolicies,
    ids::{ProfileEmployeeId, ProfileSessionId},
};
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GpuGrantSource {
    LegacySession,
    Employee,
    None,
}
impl GpuGrantSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::LegacySession => "legacy-session",
            Self::Employee => "employee",
            Self::None => "none",
        }
    }
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GpuApplied {
    device: Option<GpuDeviceUuid>,
    source: GpuGrantSource,
}
impl GpuApplied {
    pub fn project(
        policies: &GpuPolicies,
        session: &ProfileSessionId,
        employee: &ProfileEmployeeId,
    ) -> Self {
        let legacy = policies.legacy().and_then(|rows| rows.get(session));
        let selected = legacy.or_else(|| policies.employees().get(employee));
        let source = if legacy.is_some() {
            GpuGrantSource::LegacySession
        } else if selected.is_some() {
            GpuGrantSource::Employee
        } else {
            GpuGrantSource::None
        };
        let device = selected.map(|value| {
            let uuid = value
                .as_str()
                .strip_prefix("nvidia.com/gpu=GPU-")
                .expect("checked CDI prefix");
            GpuDeviceUuid::parse(&format!("GPU-{}", uuid.to_ascii_lowercase()))
                .expect("checked physical UUID")
        });
        Self { device, source }
    }
    pub fn device(&self) -> Option<&GpuDeviceUuid> {
        self.device.as_ref()
    }
    pub fn source(&self) -> GpuGrantSource {
        self.source
    }
}
