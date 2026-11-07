//! Ordinary launch's real allocation scope. This is neither API authorization
//! nor a protected-start/laptop/global-release permit.
use super::*;
use reverie_core::{
    capacity::{CapacityCounter, pool_headroom_fits},
    ids::ProfileSessionId,
    resources::{BudgetMode, ResourcePolicy},
};

/// Owns the actual thread/process-bound allocation admission and native origin.
/// It cannot be constructed, cloned or decoded from a request or plan. Drop is
/// best effort; checked close does not acknowledge global capacity release.
#[must_use = "retain and explicitly close or fail the real admission scope"]
pub struct OrdinaryLaunchAdmission {
    gate: Arc<Inner>,
    session: ProfileSessionId,
    admission: admission::Admission,
}
impl ReservationGate {
    pub fn admit_ordinary_launch(
        &self,
        session: &ProfileSessionId,
        bounds: AdmissionBounds,
    ) -> Result<OrdinaryLaunchAdmission> {
        let admission = self.inner.admit_launch(bounds, session)?;
        Ok(OrdinaryLaunchAdmission {
            gate: self.inner.clone(),
            session: session.clone(),
            admission,
        })
    }
}
impl OrdinaryLaunchAdmission {
    pub(crate) fn belongs_to(&self, gate: &ReservationGate) -> bool {
        Arc::ptr_eq(&self.gate, &gate.inner)
    }
    pub fn session(&self) -> &ProfileSessionId {
        &self.session
    }
    /// The already resolved/checked hard ceilings are DATA. Successful budget
    /// observation does not create a container or authorize a different plan.
    pub fn check_creation(&self, resources: &ResourcePolicy) -> Result<HeadroomFacts> {
        self.gate.check_ordinary_creation(&self.session, resources)
    }
    /// Source success/lease-wait exit: run the actual final native guard and
    /// consume owned admission. Other process constructors must still settle
    /// before any installing lifecycle interprets a local close as global ACK.
    pub fn close(self) -> Result<()> {
        self.admission.finish()
    }
    /// Source body failure skips the success guard and preserves both the
    /// actual primary error and mandatory checked-finalizer failures.
    pub fn fail(self, cause: GateError) -> Result<()> {
        self.admission.conclude(Err(cause))
    }
}
impl Inner {
    pub(super) fn check_ordinary_launch(
        self: &Arc<Self>,
        session: &ProfileSessionId,
    ) -> Result<()> {
        self.held(None)?;
        let sid = JournalId::parse(session.as_str())?;
        need(
            !self
                .active_operations(&self.document()?)?
                .iter()
                .any(|operation| operation.data().reserved_sid == sid),
            "RESOURCE_RESERVATION_REQUIRES_PROTECTED_RECONCILIATION",
        )
    }
    fn check_ordinary_creation(
        self: &Arc<Self>,
        session: &ProfileSessionId,
        resources: &ResourcePolicy,
    ) -> Result<HeadroomFacts> {
        self.require_host_job_idle()?;
        self.check_ordinary_launch(session)?;
        need(
            resources.budget_mode() == BudgetMode::Admission
                && reverie_core::decimal::UnsignedInteger::from_u64(
                    u64::from(resources.pool_memory_mib()) * 1_048_576,
                ) == self.config()?.pool_bytes()?,
            "RESERVATION_ADMISSION_POLICY_REQUIRED",
        )?;
        let rows = self.guard(None)?;
        let native = self.native_context()?;
        let capacity = native.capacity(&rows)?;
        let retained = self.retained_delta(&self.document()?)?;
        let budget = CapacityCounter::from_integer(capacity.budget())?;
        let committed = CapacityCounter::from_integer(capacity.total())?;
        let retained = CapacityCounter::from_integer(&retained)?;
        let candidate = CapacityCounter::try_new(u64::from(resources.memory_mib()) * 1_048_576)?;
        need(
            pool_headroom_fits(budget, committed, retained, candidate)?,
            "RESERVATION_CAPACITY_EXHAUSTED",
        )?;
        need(
            native.inventory(None)?.equivalent(&rows),
            "RESERVATION_NATIVE_INVENTORY_CHANGED",
        )?;
        Ok(HeadroomFacts {
            budget_bytes: budget.get(),
            committed_bytes: committed.get(),
            retained_bytes: retained.get(),
        })
    }
}
