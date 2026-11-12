//! The actual recovery body's held scope. No source effect handle, start
//! permit, serializable proof or callback is reconstructed by this owner.
use super::*;
pub(crate) struct RecoveryAdmission {
    gate: Arc<Inner>,
    admission: admission::Admission,
}
impl ReservationGate {
    #[cfg(test)]
    pub(crate) fn poison_recovery_cleanup_for_test(&self) {
        // Exercise the real poisoned owner branch. No error result, clock or
        // admission identity is substituted; cleanup still consumes its FD.
        let active = self
            .inner
            .state
            .lock()
            .unwrap()
            .active
            .as_ref()
            .expect("actual admitted recovery")
            .clone();
        assert!(
            std::thread::spawn(move || {
                let _held = active.lock.lock().unwrap();
                panic!("controlled poison of actual admission owner");
            })
            .join()
            .is_err()
        );
    }
    pub(crate) fn admit_recovery(&self) -> Result<RecoveryAdmission> {
        self.admit_recovery_with_bounds(AdmissionBounds::default())
    }
    pub(crate) fn admit_recovery_until(&self, end: Instant) -> Result<RecoveryAdmission> {
        self.admit_recovery_with_bounds(AdmissionBounds {
            operation: Some(end),
            entry: Some(end),
        })
    }
    fn admit_recovery_with_bounds(&self, bounds: AdmissionBounds) -> Result<RecoveryAdmission> {
        let admission = self.inner.admit(bounds)?;
        match self.inner.check_recovery() {
            Ok(_) => Ok(RecoveryAdmission {
                gate: self.inner.clone(),
                admission,
            }),
            Err(error) => admission.conclude(Err(error)),
        }
    }
}
impl RecoveryAdmission {
    pub(crate) fn host_reserve_mib(&self) -> u32 {
        self.gate.option.host_reserve_mib()
    }
    pub(crate) fn assert_pool_startup_current(
        &self,
        original: &Arc<ValidatedWorkerSnapshot>,
    ) -> Result<()> {
        self.gate.guard(None)?;
        need(
            Arc::ptr_eq(original, &self.gate.installed.snapshot()?),
            "WORKER_POOL_STARTUP_CONFIGURATION_CHANGED",
        )
    }
    pub(crate) fn check_launch(&self, session: &reverie_core::ids::ProfileSessionId) -> Result<()> {
        // Preserve the original check_launch's nonnil journal UUID rule only
        // when a real Gate exists. No-Gate name recovery still accepts nil.
        self.gate.check_ordinary_launch(session)
    }
    pub(crate) fn close(self) -> Result<()> {
        self.admission.finish()
    }
    pub(crate) fn abort(self) -> Result<()> {
        self.admission.abort()
    }
}
