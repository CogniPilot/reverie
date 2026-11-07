//! The actual recovery body's held scope. No source effect handle, start
//! permit, serializable proof or callback is reconstructed by this owner.
use super::*;
pub(crate) struct RecoveryAdmission {
    gate: Arc<Inner>,
    admission: admission::Admission,
}
impl ReservationGate {
    pub(crate) fn admit_recovery(&self) -> Result<RecoveryAdmission> {
        let admission = self.inner.admit(AdmissionBounds::default())?;
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
