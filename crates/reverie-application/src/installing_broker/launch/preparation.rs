//! The actual accepted launch enters storage preparation before owning data.
//! Its same-record hold precedes every real claim, including failed attempts.
use super::*;
use crate::installing_broker::lifecycle::{ActiveLaunchToken, LaunchGeneration};
use reverie_host::worker_reports::WorkerLaunchHold;
mod error;
mod observe;
mod wait;
use error::PreparationError;
use wait::WaitObservation;
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
struct PreparationFailure<'a> {
    preparing: PreparingWorkerLaunch<'a>,
    storage: Option<StorageClaim>,
    active: Option<ActiveLaunchToken<'a>>,
    observed: Option<WaitObservation>,
    current: Option<Arc<ValidatedWorkerSnapshot>>,
    cause: PreparationError,
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
