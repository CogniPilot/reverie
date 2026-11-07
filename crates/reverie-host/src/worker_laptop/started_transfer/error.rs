//! Failed pure transfers retain every actual once-observed input.
use super::*;
#[must_use = "retain all original observations with the unchanged resource"]
pub struct StartedOrdinaryStopTransferFailure {
    pub(super) plan: ObservedCreatePlan,
    pub(super) inspected: ExistingLaptopInspection,
    pub(super) cause: LaptopError,
}
impl StartedOrdinaryStopTransferFailure {
    pub fn code(&self) -> &'static str {
        self.cause.code()
    }
    pub fn into_parts(self) -> (ObservedCreatePlan, ExistingLaptopInspection, LaptopError) {
        (self.plan, self.inspected, self.cause)
    }
}
impl std::fmt::Debug for StartedOrdinaryStopTransferFailure {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.debug_struct("StartedOrdinaryStopTransferFailure")
            .field("cause", &self.cause)
            .finish_non_exhaustive()
    }
}
impl std::fmt::Display for StartedOrdinaryStopTransferFailure {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.cause.fmt(out)
    }
}
impl std::error::Error for StartedOrdinaryStopTransferFailure {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.cause)
    }
}
#[must_use = "retain all original observations with the unchanged resource"]
pub struct StartedReplacementStopTransferFailure {
    pub(super) plan: ObservedCreatePlan,
    pub(super) process: ExistingProcessIncarnation,
    pub(super) cause: LaptopError,
}
impl StartedReplacementStopTransferFailure {
    pub fn code(&self) -> &'static str {
        self.cause.code()
    }
    pub fn into_parts(self) -> (ObservedCreatePlan, ExistingProcessIncarnation, LaptopError) {
        (self.plan, self.process, self.cause)
    }
}
impl std::fmt::Debug for StartedReplacementStopTransferFailure {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.debug_struct("StartedReplacementStopTransferFailure")
            .field("cause", &self.cause)
            .finish_non_exhaustive()
    }
}
impl std::fmt::Display for StartedReplacementStopTransferFailure {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.cause.fmt(out)
    }
}
impl std::error::Error for StartedReplacementStopTransferFailure {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.cause)
    }
}
