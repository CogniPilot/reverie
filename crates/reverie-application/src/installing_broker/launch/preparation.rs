//! The actual accepted launch enters storage preparation before owning data.
//! Its same-record hold precedes every real claim, including failed attempts.
use super::*;
use crate::installing_broker::lifecycle::{ActiveLaunchToken, LaunchGeneration};
use reverie_host::worker_launch::ExistingLaptopInspection;
use reverie_host::worker_reports::WorkerLaunchHold;
mod cold;
mod error;
pub(in crate::installing_broker) use cold::StartedLaptop;
pub use cold::{AllocationClosedCold, ColdLaunchFailure};
mod existing;
pub use existing::{
    AllocationClosedReuse, ClassifiedWorkerLaunch, ColdWorkerLaunch, ExistingColdTarget,
    PreparedReuseViewer, RestoredReuse, ReusableWorkerLaunch, ReuseViewerFailure, ViewingReuse,
};
mod finalization;
mod observe;
mod wait;
use error::PreparationError;
use wait::WaitObservation;
#[cfg(test)]
mod prefix_tests;
#[cfg(test)]
mod stop_scope_tests;
#[cfg(test)]
mod tests;

/// This private owner is constructed only by consuming the original admitted J.
/// It cannot be assembled from request/configuration/resource path data.
struct PreparingWorkerLaunch<'a> {
    admitted: AdmittedWorkerLaunch<'a>,
    hold: Option<WorkerLaunchHold>,
}
struct ClaimedWorkerLaunch<'a> {
    preparing: PreparingWorkerLaunch<'a>,
    observed: WaitObservation,
    storage: Option<StorageClaim>,
    active: Option<ActiveLaunchToken<'a>>,
    lifecycle: LaptopLifecycle<'a>,
}
/// Real constructor prefix through first inspect, retaining the original
/// lifecycle guard, accepted connection, counted hold and actual resource.
#[must_use = "continue or abort the SAME preparation; path data cannot replace it"]
pub struct InspectedWorkerLaunch<'a> {
    observed: observe::ObservedWorkerLaunch<'a>,
    previous: Option<ExistingLaptopInspection>,
}
#[must_use = "resource acquisition can remain uncertain even when storage is None"]
pub struct PreparationFailure<'a> {
    preparing: PreparingWorkerLaunch<'a>,
    storage: Option<StorageClaim>,
    active: Option<ActiveLaunchToken<'a>>,
    observed: Option<WaitObservation>,
    current: Option<Arc<ValidatedWorkerSnapshot>>,
    cause: PreparationError,
    transport_attempted: bool,
    cleanup: Vec<WorkerDispatchError>,
}
impl<'a> AdmittedWorkerLaunch<'a> {
    /// Original prefix with existing per-query policy, not a reset of the
    /// retained admission or ten-second wait budget. This is not full launch.
    pub fn prepare_prefix(self) -> Result<InspectedWorkerLaunch<'a>, Box<PreparationFailure<'a>>> {
        let observed = PreparingWorkerLaunch::enter(self)?.claim()?.observe()?;
        let runtime = &observed.claimed.preparing.broker().storage.runtime;
        let end = Instant::now() + std::time::Duration::from_secs(20);
        let end = runtime.stop_deadline().map_or(end, |stop| stop.min(end));
        observed.inspect(end)
    }
}
impl InspectedWorkerLaunch<'_> {
    /// DATA only; reuse still needs policy/memory/runtime/exit/pane phases.
    pub fn previous(&self) -> Option<&reverie_contracts::broker_laptop::LaunchLaptopInspection> {
        self.previous.as_ref().map(ExistingLaptopInspection::data)
    }
    pub fn request(&self) -> &WorkerRequest {
        self.observed.claimed.preparing.admitted.request()
    }
    pub fn configuration(&self) -> &ValidatedWorkerSnapshot {
        &self.observed.current
    }
}
impl PreparationFailure<'_> {
    pub fn cause(&self) -> &(dyn std::error::Error + 'static) {
        &self.cause
    }
}
impl std::fmt::Debug for PreparationFailure<'_> {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.debug_struct("LaunchPreparationFailure")
            .field("cause", &self.cause)
            .field("direct_storage_reference", &self.storage.is_some())
            .field("active_reference", &self.active.is_some())
            .field(
                "waited",
                &self.observed.as_ref().map(WaitObservation::waited),
            )
            .field("current_snapshot_reference", &self.current.is_some())
            .field("cleanup", &self.cleanup)
            .finish()
    }
}
impl std::fmt::Display for PreparationFailure<'_> {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.cause.fmt(out)
    }
}
impl std::error::Error for PreparationFailure<'_> {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.cause)
    }
}
impl<'a> PreparingWorkerLaunch<'a> {
    fn enter(admitted: AdmittedWorkerLaunch<'a>) -> Result<Self, Box<PreparationFailure<'a>>> {
        let hold = admitted.request.connection.retain_lifecycle();
        let mut owner = Self {
            admitted,
            hold: None,
        };
        match hold {
            Ok(hold) => {
                owner.hold = Some(hold);
                Ok(owner)
            }
            Err(error) => Err(Box::new(PreparationFailure {
                preparing: owner,
                storage: None,
                active: None,
                observed: None,
                current: None,
                cause: error.into(),
                transport_attempted: false,
                cleanup: Vec::new(),
            })),
        }
    }
    fn broker(&self) -> &'a InstallingBroker {
        self.admitted.request.broker
    }
    fn claim(mut self) -> Result<ClaimedWorkerLaunch<'a>, Box<PreparationFailure<'a>>> {
        let observed = match WaitObservation::capture(&self) {
            Ok(observed) => observed,
            Err(cause) => {
                return Err(Box::new(PreparationFailure {
                    preparing: self,
                    storage: None,
                    active: None,
                    observed: None,
                    current: None,
                    cause,
                    transport_attempted: false,
                    cleanup: Vec::new(),
                }));
            }
        };
        let storage = match self.acquire_storage(&observed) {
            Ok(storage) => storage,
            Err(cause) => {
                return Err(Box::new(PreparationFailure {
                    preparing: self,
                    storage: None,
                    active: None,
                    observed: Some(observed),
                    current: None,
                    cause,
                    transport_attempted: false,
                    cleanup: Vec::new(),
                }));
            }
        };
        match self.register(&observed) {
            Ok((active, lifecycle)) => Ok(ClaimedWorkerLaunch {
                preparing: self,
                observed,
                storage: Some(storage),
                active: Some(active),
                lifecycle,
            }),
            Err(cause) => Err(Box::new(PreparationFailure {
                preparing: self,
                storage: Some(storage),
                active: None,
                observed: Some(observed),
                current: None,
                cause,
                transport_attempted: false,
                cleanup: Vec::new(),
            })),
        }
    }
    fn register(
        &mut self,
        observed: &WaitObservation,
    ) -> Result<(ActiveLaunchToken<'a>, LaptopLifecycle<'a>), PreparationError> {
        let broker = self.broker();
        let mut lifecycle = broker.installed.lifecycle()?;
        observed.check_if_waited(self, &lifecycle)?;
        lifecycle.check_active_available(&observed.generation, &self.admitted)?;
        self.assert_allowed()?;
        let active =
            lifecycle.claim_active(&observed.generation, &self.admitted, &mut self.hold)?;
        // Keep the SAME mutex across cold/storage/runtime/argument and reuse
        // phases. Only the actual Nix transition releases it for long copying.
        Ok((active, lifecycle))
    }
    fn assert_allowed(&self) -> Result<(), PreparationError> {
        if self.broker().storage.runtime.cancellation().is_cancelled()
            || !self.broker().allowed(self.admitted.request().session())?
        {
            return Err(PreparationError::Refused(
                "This expert is stopped or on vacation",
            ));
        }
        Ok(())
    }
}
