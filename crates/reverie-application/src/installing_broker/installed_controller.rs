//! Custody transfer of the original activated Host owner. Installation here
//! does not publish a fleet policy, clear a provider fence or admit a worker.
use super::*;
use reverie_host::worker_laptop::{ControllerMemberConfigured, CreatedLaptop, StartedContainer};
use reverie_host::worker_pool::{ActivatedController, PoolError};
use reverie_host::worker_reports::WorkerLaunchConnection;
use std::time::Instant;

/// One allocation owns the consuming native controller success. Gate borrows
/// this same slot; no status document or second controller is installed there.
pub(crate) type InstalledControllerSlot =
    Arc<Mutex<Option<reverie_host::worker_pool::ActivatedController>>>;

#[must_use = "retain the same activated controller when transfer refuses"]
pub struct ControllerInstallFailure {
    owner: ActivatedController,
    cause: PoolError,
}
impl ControllerInstallFailure {
    pub fn cause(&self) -> &PoolError {
        &self.cause
    }
    /// Component closure only; never acknowledges worker or pool release.
    pub fn close_components(&mut self, end: Instant) -> Result<(), PoolError> {
        self.owner.close_components(end)
    }
}
impl std::fmt::Display for ControllerInstallFailure {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.cause.fmt(out)
    }
}
impl std::fmt::Debug for ControllerInstallFailure {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        std::fmt::Display::fmt(self, out)
    }
}
impl std::error::Error for ControllerInstallFailure {}

impl InstallingBroker {
    pub(in crate::installing_broker) fn configure_controller_member(
        &self,
        source: &reverie_contracts::worker_config::EffectiveWorkerConfig,
        created: &CreatedLaptop,
        started: &StartedContainer,
        connection: &WorkerLaunchConnection,
        end: Instant,
    ) -> Result<Option<ControllerMemberConfigured>, PoolError> {
        if reverie_contracts::worker_pool::WorkerPoolProvider::from_config(source)
            .map_err(|_| PoolError::Refused("WORKER_POOL_PROVIDER_INVALID"))?
            .is_none()
        {
            return Ok(None);
        }
        let mut slot = self
            .controller
            .try_lock()
            .map_err(|_| PoolError::Refused("WORKER_CONTROLLER_SLOT_UNAVAILABLE"))?;
        slot.as_mut()
            .map(|owner| {
                owner.configure_created_member(
                    &self.storage.runtime,
                    created,
                    started,
                    connection,
                    end,
                )
            })
            .transpose()
    }
    pub(in crate::installing_broker) fn assert_installed_controller_current(
        &self,
        end: Instant,
    ) -> Result<(), PoolError> {
        let mut slot = self
            .controller
            .try_lock()
            .map_err(|_| PoolError::Refused("WORKER_CONTROLLER_SLOT_UNAVAILABLE"))?;
        slot.as_mut()
            .ok_or(PoolError::Refused("WORKER_CONTROLLER_NOT_INSTALLED"))?
            .assert_current(&self.storage.runtime, end)
    }
    /// Takes the actual consuming Host success, never a parsed status, ID or
    /// whole App bootstrap (which would retain this broker through an Arc cycle).
    pub fn install_activated_controller(
        &self,
        mut owner: ActivatedController,
    ) -> Result<(), Box<ControllerInstallFailure>> {
        if let Err(cause) = owner.assert_current(
            &self.storage.runtime,
            Instant::now() + std::time::Duration::from_secs(20),
        ) {
            return Err(Box::new(ControllerInstallFailure { owner, cause }));
        }
        let mut slot = match self.controller.try_lock() {
            Ok(slot) => slot,
            Err(_) => {
                return Err(Box::new(ControllerInstallFailure {
                    owner,
                    cause: PoolError::Refused("WORKER_CONTROLLER_SLOT_UNAVAILABLE"),
                }));
            }
        };
        if slot.is_some() {
            return Err(Box::new(ControllerInstallFailure {
                owner,
                cause: PoolError::Refused("WORKER_CONTROLLER_ALREADY_INSTALLED"),
            }));
        }
        *slot = Some(owner);
        Ok(())
    }
    pub(super) fn close_installed_controller(
        &self,
        workers_closed: bool,
        end: Instant,
    ) -> Result<(), PoolError> {
        let mut slot = self
            .controller
            .try_lock()
            .map_err(|_| PoolError::Refused("WORKER_CONTROLLER_SLOT_UNAVAILABLE"))?;
        let Some(owner) = slot.as_mut() else {
            return Ok(());
        };
        if !workers_closed {
            return Err(PoolError::Refused("WORKER_CONTROLLER_RESOURCES_RETAINED"));
        }
        owner.close_components(end)?;
        *slot = None;
        Ok(())
    }
}
