//! Private stop-observation vocabulary; the enclosing owner holds real storage.
use super::*;
use reverie_core::{
    decimal::UnsignedInteger,
    ids::{ContainerId, ProfileSessionId},
    worker_laptop::WorkerContainerName,
};
pub(super) enum StopIdentity {
    Protected(SourceStopName),
    Ordinary {
        name: WorkerContainerName,
        session: ProfileSessionId,
        container: ContainerId,
        pid: UnsignedInteger,
        start: String,
    },
}
impl StopIdentity {
    pub(super) fn name(&self) -> &WorkerContainerName {
        match self {
            Self::Protected(name) => name.name(),
            Self::Ordinary { name, .. } => name,
        }
    }
    pub(super) fn session(&self) -> &ProfileSessionId {
        match self {
            Self::Protected(name) => name.session(),
            Self::Ordinary { session, .. } => session,
        }
    }
    pub(super) fn container(&self) -> &ContainerId {
        match self {
            Self::Protected(name) => name.container(),
            Self::Ordinary { container, .. } => container,
        }
    }
    pub(super) fn pid(&self) -> Result<UnsignedInteger> {
        match self {
            Self::Protected(name) => name.native().pid().map_err(SourceStopError::NativeData),
            Self::Ordinary { pid, .. } => Ok(pid.clone()),
        }
    }
    pub(super) fn start_matches(&self, observed: &str) -> Result<bool> {
        match self {
            Self::Protected(name) => name
                .native()
                .start_matches(observed)
                .map_err(SourceStopError::NativeData),
            Self::Ordinary { start, .. } => Ok(start == observed),
        }
    }
    pub(super) fn process_start(&self, end: Instant) -> Result<String> {
        let result = match self {
            Self::Protected(name) => crate::reservation_kernel::ReservationKernel::new()
                .original_process_start(name.native(), end),
            Self::Ordinary { pid, .. } => {
                crate::reservation_kernel::existing_process_start(pid, end)
            }
        };
        result.map_err(SourceStopError::Kernel)
    }
}
