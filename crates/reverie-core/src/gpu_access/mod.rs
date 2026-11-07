//! Owner GPU intent and queue DATA. No device, launch or actor authority.
mod physical;
mod policy;
mod status;
pub use status::{GpuActiveData, GpuChoice, GpuChoicesData, GpuStatusData, GpuStatusState};
mod request;
pub use physical::PhysicalGpu;
pub use policy::{GpuApplied, GpuGrantSource};
pub use request::{GpuBinding, GpuExpected, GpuIntent, GpuQueuedRequest, GpuRequestDocument};
use std::fmt;

pub const MAX_REQUESTS: usize = 256;
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GpuAccessError {
    DeviceSelection,
    RequestCasSchema,
    RequestStore,
    RequestStoreFull,
    StaleRequest,
    PhysicalMetadata,
    StatusData,
}
impl GpuAccessError {
    pub fn code(self) -> &'static str {
        match self {
            Self::DeviceSelection => "GPU_DEVICE_SELECTION",
            Self::RequestCasSchema => "GPU_REQUEST_CAS_SCHEMA",
            Self::RequestStore => "GPU_REQUEST_STORE",
            Self::RequestStoreFull => "GPU_REQUEST_STORE_FULL",
            Self::StaleRequest => "GPU_STALE_REQUEST",
            Self::PhysicalMetadata => "GPU_HARDWARE_UNAVAILABLE",
            Self::StatusData => "GPU_STATUS_DATA",
        }
    }
}
impl fmt::Display for GpuAccessError {
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        output.write_str(self.code())
    }
}
impl std::error::Error for GpuAccessError {}
pub type Result<T> = std::result::Result<T, GpuAccessError>;

/// The queue selects canonical lowercase physical UUIDs, including nil; it
/// does not use the nonnil employee/operation identity policy for devices.
#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct GpuDeviceUuid(String);
impl GpuDeviceUuid {
    pub fn parse(value: &str) -> Result<Self> {
        let Some(uuid) = value.strip_prefix("GPU-") else {
            return Err(GpuAccessError::DeviceSelection);
        };
        // Reuse the existing physical CDI syntax owner; this queue adds only
        // its source's lowercase-hex representation requirement.
        if uuid.bytes().any(|byte| byte.is_ascii_uppercase())
            || crate::device_policy::NvidiaCdiDevice::parse(&format!("nvidia.com/gpu={value}"))
                .is_err()
        {
            return Err(GpuAccessError::DeviceSelection);
        }
        Ok(Self(value.into()))
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
    pub fn device(&self) -> crate::device_policy::NvidiaCdiDevice {
        crate::device_policy::NvidiaCdiDevice::parse(&format!("nvidia.com/gpu={}", self.0))
            .expect("checked GPU UUID")
    }
}
