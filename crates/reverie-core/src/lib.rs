//! Checked domain values. No wire decoder, process authority or host effects.
pub mod ids;
pub mod profiles;
pub mod resources;
pub mod revision;

use std::fmt;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ValueError {
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
