//! Checked domain values. No wire decoder, process authority or host effects.
pub mod capacity;
pub mod decimal;
pub mod device_policy;
pub mod gpu_access;
pub mod host_scope;
pub mod ids;
pub mod lease_policy;
pub mod memory;
pub mod memory_configuration;
pub mod memory_context;
pub mod memory_documents;
pub mod memory_instance;
pub mod operations;
pub mod ops;
pub mod persona;
pub mod posix_path;
pub mod posix_text;
pub mod privacy_floor;
pub mod profiles;
pub(crate) mod python_text;
pub use python_text::trim_text as python_trim_text;
pub use python_text::{python_lowercase_character, python_lowercase_string, python_numeric_text};
pub mod resource_projection;
pub mod resources;
pub mod revision;
pub mod rootless;
pub mod shutdown;
pub mod task_perf;
pub mod worker_child;
pub mod worker_laptop;
pub mod worker_launch;
pub mod worker_options;
pub mod worker_schema;

pub use python_text::{PythonText, PythonTextError, PythonTextRef};
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
