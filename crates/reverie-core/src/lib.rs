//! Checked domain values. No wire decoder, process authority or host effects.
pub mod capacity;
pub mod decimal;
pub mod device_policy;
pub mod ids;
pub mod lease_policy;
pub mod memory;
pub mod operations;
pub mod posix_path;
pub mod profiles;
pub(crate) mod python_text;
pub mod resource_projection;
pub mod resources;
pub mod revision;
pub mod rootless;
pub mod task_perf;
pub mod worker_launch;
pub mod worker_options;
pub mod worker_schema;

use std::fmt;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ValueError {
    ContainerId,
    CanonicalUuid,
    NativeUuid,
    NilOperationId,
    CounterRange,
    CpuLimit,
    ResourceLimit,
    GenerationRegression,
    EmployeeBinding,
}

impl ValueError {
    pub fn code(self) -> &'static str {
        match self {
            Self::ContainerId => "CONTAINER_ID",
            Self::CanonicalUuid => "CANONICAL_UUID",
            Self::NativeUuid | Self::NilOperationId => "UUID",
            Self::CounterRange => "VERSION_TYPE",
            Self::CpuLimit | Self::ResourceLimit => "RESOURCE_LIMIT",
            Self::GenerationRegression => "GENERATION_REGRESSION",
            Self::EmployeeBinding => "EMPLOYEE_BINDING",
        }
    }
}

impl fmt::Display for ValueError {
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        output.write_str(self.code())
    }
}
impl std::error::Error for ValueError {}
