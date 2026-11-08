//! Service finally closes actual Office producers before checking remaining
//! resource custody. This is not C stop-laptops or a capacity-release shortcut.
use super::*;
impl RecoveryOwners {
    pub(in crate::installing_broker) fn close_service_owners(
        &self,
        broker: &InstallingBroker,
        end: std::time::Instant,
    ) -> Result<()> {
        let office = self
            .office
            .try_lock()
            .map_err(|_| RecoveryError::Refused("WORKER_OFFICE_REGISTRY_UNAVAILABLE"))?
            .clone();
        // No lifecycle/Gate/registry lock remains held across the real joins.
        if let Some(office) = &office {
            office.close(end)?;
        }
        if !self
            .uncertain
            .try_lock()
            .is_ok_and(|claims| claims.is_empty())
            || !broker.storage.known_empty_for_service_drop()
        {
            return Err(RecoveryError::Refused("WORKER_SERVICE_STORAGE_RETAINED"));
        }
        {
            let state = broker
                .installed
                .laptops
                .try_lock()
                .map_err(|_| RecoveryError::Refused("WORKER_SERVICE_LIFECYCLE_RETAINED"))?;
            if !state.transients_empty() || !state.is_empty() {
                return Err(RecoveryError::Refused("WORKER_SERVICE_LAPTOPS_RETAINED"));
            }
        }
        // An Office close result cannot remove committed storage ownership.
        // Only after all original App owners are disposed may this exact
        // already-closed service allocation be removed from its original slot.
        let mut slot = self
            .office
            .try_lock()
            .map_err(|_| RecoveryError::Refused("WORKER_OFFICE_REGISTRY_UNAVAILABLE"))?;
        if !match (&*slot, &office) {
            (None, None) => true,
            (Some(current), Some(original)) => Arc::ptr_eq(current, original),
            _ => false,
        } {
            return Err(RecoveryError::Refused("WORKER_OFFICE_REGISTRY_CHANGED"));
        }
        *slot = None;
        Ok(())
    }
}
