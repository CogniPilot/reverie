//! Journal custody for one real authenticated RAM operation. The original Q
//! owner retains the strong reference; stores keep only a revocable weak one.
use super::*;
use crate::installing_broker::resource_actor::AuthenticatedResourceOperation;
use reverie_contracts::resource_actor::CurrentResourceOwner;
use reverie_core::ids::ProfileEmployeeId;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

pub(super) struct RamJournalAuthority {
    gate: Weak<Inner>,
    pin: reverie_host::worker_reports::ResourceJournalPin,
    employee: ProfileEmployeeId,
    owner: CurrentResourceOwner,
    active: Mutex<Option<Weak<Active>>>,
    failed: AtomicBool,
}
impl RamJournalAuthority {
    pub(super) fn capture(
        gate: &ReservationGate,
        operation: &AuthenticatedResourceOperation<'_>,
    ) -> Result<Arc<Self>> {
        operation
            .assert_reservation_gate(gate)
            .map_err(|error| GateError::Refused(error.code()))?;
        Ok(Arc::new(Self {
            gate: Arc::downgrade(&gate.inner),
            pin: operation
                .retain_ram_journal_pin(gate)
                .map_err(|error| GateError::Refused(error.code()))?,
            employee: operation.request().employee_id().clone(),
            owner: operation
                .current_owner()
                .map_err(|error| GateError::Refused(error.code()))?
                .clone(),
            active: Mutex::new(None),
            failed: AtomicBool::new(false),
        }))
    }
    pub(super) fn bind(&self, gate: &Arc<Inner>, active: &Arc<Active>) -> Result<()> {
        need(
            self.gate
                .upgrade()
                .is_some_and(|own| Arc::ptr_eq(&own, gate))
                && !self.failed.load(Ordering::Acquire),
            "RESOURCE_RAM_JOURNAL_PURPOSE_CHANGED",
        )?;
        let mut selected = self
            .active
            .try_lock()
            .map_err(|_| GateError::Refused("RESOURCE_RAM_JOURNAL_UNAVAILABLE"))?;
        need(selected.is_none(), "RESOURCE_RAM_JOURNAL_SCOPE_RETAINED")?;
        *selected = Some(Arc::downgrade(active));
        Ok(())
    }
    pub(super) fn revoke(&self, active: &Arc<Active>) -> Result<()> {
        let mut selected = self
            .active
            .lock()
            .map_err(|_| GateError::Refused("RESOURCE_RAM_JOURNAL_UNAVAILABLE"))?;
        need(
            selected
                .as_ref()
                .and_then(Weak::upgrade)
                .is_some_and(|own| Arc::ptr_eq(&own, active)),
            "RESOURCE_RAM_JOURNAL_PURPOSE_CHANGED",
        )?;
        *selected = None;
        Ok(())
    }
    pub(super) fn assert_current(&self, gate: &Arc<Inner>, active: &Arc<Active>) -> Result<()> {
        let result = self.current(gate, active);
        if result.is_err() {
            self.failed.store(true, Ordering::Release);
        }
        result
    }
    fn current(&self, gate: &Arc<Inner>, active: &Arc<Active>) -> Result<()> {
        need(
            !self.failed.load(Ordering::Acquire),
            "RESOURCE_RAM_JOURNAL_FAILED",
        )?;
        need(
            self.gate
                .upgrade()
                .is_some_and(|own| Arc::ptr_eq(&own, gate))
                && self
                    .active
                    .try_lock()
                    .map_err(|_| GateError::Refused("RESOURCE_RAM_JOURNAL_UNAVAILABLE"))?
                    .as_ref()
                    .and_then(Weak::upgrade)
                    .is_some_and(|own| Arc::ptr_eq(&own, active)),
            "RESOURCE_RAM_JOURNAL_PURPOSE_CHANGED",
        )?;
        self.pin
            .assert_current()
            .map_err(|error| GateError::Actor(Box::new(error)))?;
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| GateError::Refused("RESOURCE_ACTOR_OWNER_EXPIRED"))?
            .as_millis();
        let expires = u128::from(self.owner.expires_at_epoch_ms());
        need(
            expires > now && expires - now <= 300_000,
            "RESOURCE_ACTOR_OWNER_EXPIRED",
        )?;
        reverie_store::storage_identity::read_company_metadata(&gate.identity)?
            .require_resource_owner(&self.employee, self.owner.owner())
            .map_err(|error| GateError::Refused(error.code()))?;
        self.pin
            .assert_current()
            .map_err(|error| GateError::Actor(Box::new(error)))
    }
}
