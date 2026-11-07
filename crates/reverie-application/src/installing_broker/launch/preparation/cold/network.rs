//! The late Office phase precedes network. The original Nix/plan/phone owners
//! move atomically into the SAME original-J Host record or return unchanged.
use super::*;
use reverie_host::worker_laptop::{ColdPreparation, LaptopNetworkProgress};
impl ColdBody<'_> {
    pub(super) fn prepare_network(&mut self) -> Result<(), ColdError> {
        // The removal proof belongs to the still-held successful Nix record.
        // Validate it before Office construction or actual resource transfer.
        let Resources::CopyingNix(input) =
            self.resources.as_ref().expect("actual copied resources")
        else {
            unreachable!("network follows successful copy");
        };
        match &input.removal {
            CopiedRemoval::Unobserved => {}
            CopiedRemoval::Removed(proof) => input.preparation.check_removed_laptop(proof)?,
            CopiedRemoval::Pending(_) => {
                return Err(ColdError::Refused("WORKER_COLD_OLD_LAPTOP_NOT_REMOVED"));
            }
        }
        self.open_office()?;
        let office = self.office.as_ref().expect("actual completed Office");
        let phone = office._office.retain_phone(&office._phone)?;
        let connection = self.scope.preparing.admitted.request.connection.clone();
        let Resources::CopyingNix(input) = self.resources.take().expect("actual copied resources")
        else {
            unreachable!("network follows successful copy");
        };
        let CopyingNix {
            preparation,
            plan,
            prepared,
            removal,
        } = input;
        match preparation.retain_network_for_connection(plan, phone, &connection) {
            Ok(preparation) => self.resources = Some(Resources::NetworkHeld(Arc::new(preparation))),
            Err(failure) => {
                let (preparation, plan, _request, phone, error) = failure.into_parts();
                self.network_phone = Some(phone);
                self.resources = Some(Resources::CopyingNix(CopyingNix {
                    preparation,
                    plan,
                    prepared,
                    removal,
                }));
                return Err(error.into());
            }
        }
        let Some(Resources::NetworkHeld(network)) = self.resources.take() else {
            unreachable!("new retained network has not been dispatched");
        };
        self.resources = Some(Resources::Network(network.clone()));
        // Retain attempted ownership BEFORE the first possible native call.
        // Finally cannot treat a failed or lost response as undispatched.
        match network.run_for_connection(&connection)? {
            LaptopNetworkProgress::Ready => {}
            LaptopNetworkProgress::Rejected | LaptopNetworkProgress::Retained => {
                return Err(Self::phase_refused(
                    &network,
                    "WORKER_COLD_NETWORK_UNCONFIRMED",
                ));
            }
        }
        // Clear has its original explicit ten-second window. Retention is
        // already prepared before Office, and this named phase checks it.
        let end = Instant::now() + std::time::Duration::from_secs(10);
        match network.prepare_cold(end)? {
            ColdPreparation::Prepared(_) => Ok(()),
            ColdPreparation::Rejected | ColdPreparation::Retained => Err(Self::phase_refused(
                &network,
                "WORKER_COLD_TEMPORARY_UNCONFIRMED",
            )),
        }
    }
    fn open_office(&mut self) -> Result<(), ColdError> {
        let sid = self.scope.preparing.admitted.request().session();
        if let Some(entry) = self
            .lifecycle()
            .guard
            .iter()
            .find(|entry| &entry.session == sid)
        {
            let office = match &entry.owner {
                LaptopOwner::Recovered(owner) => &owner.office,
                LaptopOwner::Started(owner) => &owner.office,
                #[cfg(test)]
                LaptopOwner::Modeled => {
                    return Err(ColdError::Refused("WORKER_MODELED_OFFICE_IS_NOT_OWNER"));
                }
            };
            let phone = office._office.retain_phone(&office._phone)?;
            self.office = Some(Arc::new(RecoveredOffice {
                _phone: phone,
                _office: office._office.clone(),
            }));
            return Ok(());
        }
        let current = self.broker().configuration()?;
        let office = self.broker().recovery.office(self.broker(), &current)?;
        match office.bind_worker_retained(sid.clone()) {
            Ok(phone) => {
                self.office = Some(Arc::new(RecoveredOffice {
                    _phone: phone,
                    _office: office,
                }));
                Ok(())
            }
            Err(failure) => {
                let (error, construction) = failure.into_parts();
                self.construction = construction.map(|owner| (office, owner));
                Err(error.into())
            }
        }
    }
    pub(super) fn network(&self) -> Arc<storage::NetworkStoragePreparation> {
        let Some(Resources::Network(network) | Resources::NetworkHeld(network)) = &self.resources
        else {
            unreachable!("actual network resources retained");
        };
        network.clone()
    }
    pub(super) fn phase_refused(
        network: &storage::NetworkStoragePreparation,
        phase: &'static str,
    ) -> ColdError {
        match network.phase_failure() {
            Ok(Some(error)) => ColdError::Recorded(error),
            Ok(None) => ColdError::Refused(phase),
            Err(error) => error.into(),
        }
    }
}
