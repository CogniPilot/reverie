//! Supported OS installation entry. A nomination is read before origin or
//! publication; either failure retains the original broker or original offer.
use super::*;

#[must_use = "retain the actual broker or original failed installation offer"]
pub struct OsPoolInstallationFailure {
    owner: FailedOwner,
}
enum FailedOwner {
    Source {
        _broker: Box<InstallingBroker>,
        cause: reverie_host::worker_pool::PoolError,
    },
    Offer(Box<BrokerInstallationOfferFailure>),
}
impl InstallingBroker {
    /// Explicit OS role only. This grants no website or fleet authority.
    pub fn prepare_os_pool_installation_offer(
        self,
        end: Instant,
    ) -> Result<BrokerInstallationOffer, Box<OsPoolInstallationFailure>> {
        let request = match reverie_host::worker_pool::load_os_pool_installation_request() {
            Ok(request) => request,
            Err(cause) => {
                return Err(Box::new(OsPoolInstallationFailure {
                    owner: FailedOwner::Source {
                        _broker: Box::new(self),
                        cause,
                    },
                }));
            }
        };
        self.prepare_pool_installation_offer(request, end)
            .map_err(|owner| {
                Box::new(OsPoolInstallationFailure {
                    owner: FailedOwner::Offer(owner),
                })
            })
    }
}
impl std::fmt::Debug for OsPoolInstallationFailure {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        std::fmt::Display::fmt(self, out)
    }
}
impl std::fmt::Display for OsPoolInstallationFailure {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match &self.owner {
            FailedOwner::Source { cause, .. } => cause.fmt(out),
            FailedOwner::Offer(owner) => owner.fmt(out),
        }
    }
}
impl std::error::Error for OsPoolInstallationFailure {}
