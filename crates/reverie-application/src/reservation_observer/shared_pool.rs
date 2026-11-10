//! The SAME installed controller is borrowed under its original slot lock.
//! Selection DATA cannot install an owner or authorize provider creation.
use super::*;
use reverie_core::decimal::UnsignedInteger;
use reverie_host::worker_pool::{ActivatedController, ControllerCapacity};

impl ObservationContext {
    pub(super) fn shared_capacity<'owner>(
        &self,
        slot: Option<&'owner mut Option<ActivatedController>>,
        website: &WebsiteBinding,
        end: Instant,
    ) -> Result<Option<ControllerCapacity<'owner>>> {
        let provider = reverie_contracts::worker_pool::WorkerPoolProvider::from_config(
            self.config.configuration(),
        )
        .map_err(|_| ObserverError::Refused("RESERVATION_POOL_PROVIDER_INVALID"))?;
        let owner = slot.and_then(Option::as_mut);
        match (provider.as_ref(), owner) {
            (None, None) => Ok(None),
            (Some(provider), Some(owner)) => {
                need(
                    self.config.pool_bytes()?
                        == UnsignedInteger::from_u64(
                            u64::from(provider.policy().memory_max_mi_b) * 1_048_576,
                        ),
                    "RESERVATION_POOL_PARENT_BUDGET",
                )?;
                let WebsiteBinding::Running(website) = website else {
                    return Err(ObserverError::Refused("RESERVATION_POOL_WEBSITE_REQUIRED"));
                };
                self.observer
                    .source
                    .controller_capacity(owner, provider.policy(), website, end)
                    .map(Some)
            }
            _ => Err(ObserverError::Refused(
                "RESERVATION_POOL_CONTROLLER_REQUIRED",
            )),
        }
    }
}
