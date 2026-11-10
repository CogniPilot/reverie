//! Reservation custody for one live employee policy update.
use super::*;
use crate::installing_broker::{LaptopLifecycle, resource_actor::AuthenticatedResourceOperation};
use reverie_contracts::{
    resource_actor::ResourceRequestSelection, worker_pool::WorkerPoolConfigurationTransition,
};
use reverie_host::{
    reservation_control::{
        MemberPolicyCancellation, MemberPolicyPending, MemberPolicyPublication, PoolTerminal,
    },
    worker_pool::PreparedMemberPolicyEdit,
};
use std::sync::MutexGuard;

pub(crate) struct MemberPolicyAdmission {
    gate: Arc<Inner>,
    admission: admission::Admission,
    configuration: Arc<ReservationConfiguration>,
    binding: ControlBinding,
    before: Arc<ValidatedWorkerSnapshot>,
}

pub(crate) enum MemberPolicyEnd {
    Applied(PoolTerminal),
    Rejected(MemberPolicyCancellation),
}

pub(super) type RetainedMemberPolicy = (MemberPolicyPending, Arc<PreparedMemberPolicyEdit>);

impl ReservationGate {
    pub(crate) fn admit_member_policy(
        &self,
        operation: &AuthenticatedResourceOperation<'_>,
    ) -> Result<MemberPolicyAdmission> {
        let gate = &self.inner;
        need(
            matches!(
                operation.request().selection(),
                ResourceRequestSelection::EmployeePolicyEdit { .. }
            ),
            "EMPLOYEE_RESOURCE_APPROVAL_REQUIRED",
        )?;
        let bounds = operation
            .ram_admission_bounds(self)
            .map_err(|error| GateError::Refused(error.code()))?;
        let admission = gate.admit(bounds)?;
        let selection = (|| {
            gate.require_host_job_idle()?;
            need(
                gate.active_operations(&gate.document()?)?.is_empty(),
                "EMPLOYEE_RESOURCE_ACTIVE_OPERATION",
            )?;
            let before = gate.installed.snapshot()?;
            let (configuration, binding) = gate.installed.bound_resources(&gate.binding)?;
            Ok((before, configuration, binding))
        })();
        match selection {
            Ok((before, configuration, binding)) => Ok(MemberPolicyAdmission {
                gate: Arc::clone(gate),
                admission,
                configuration,
                binding,
                before,
            }),
            Err(error) => finalized(Err(error), admission.abort()),
        }
    }
}

impl MemberPolicyAdmission {
    pub(crate) fn assert_snapshot(&self, before: &Arc<ValidatedWorkerSnapshot>) -> Result<()> {
        need(
            Arc::ptr_eq(before, &self.before)
                && Arc::ptr_eq(before, &self.gate.installed.snapshot()?),
            "EMPLOYEE_RESOURCE_CONFIGURATION_CHANGED",
        )
    }

    pub(crate) fn binding(&self) -> &ControlBinding {
        &self.binding
    }

    pub(crate) fn native_lock(&self) -> Result<MutexGuard<'_, AdmissionLock>> {
        self.admission
            .active
            .lock
            .lock()
            .map_err(|_| GateError::Refused("RESERVATION_ADMISSION_UNAVAILABLE"))
    }

    pub(crate) fn establish(
        &self,
        transition: Arc<WorkerPoolConfigurationTransition>,
        edit: &PreparedMemberPolicyEdit,
    ) -> Result<MemberPolicyPending> {
        self.assert_snapshot(&self.before)?;
        self.gate.guard(None)?;
        let lock = self.native_lock()?;
        Ok(MemberPolicyPending::establish(
            &self.configuration,
            &self.binding,
            &lock,
            transition,
            edit,
            &self.gate.scope,
        )?)
    }

    pub(crate) fn publish(
        &self,
        lifecycle: &LaptopLifecycle<'_>,
        after: &Arc<ValidatedWorkerSnapshot>,
        proof: &MemberPolicyPublication<'_>,
    ) -> Result<()> {
        let active = self.gate.held(None)?;
        need(
            Arc::ptr_eq(&active, &self.admission.active),
            "RESERVATION_ADMISSION_LOCK_REQUIRED",
        )?;
        let mut context = active
            .context
            .lock()
            .map_err(|_| GateError::Refused("RESERVATION_ADMISSION_UNAVAILABLE"))?;
        self.gate.installed.publish_member_policy(
            &self.before,
            after,
            lifecycle,
            &mut context,
            &self.gate.binding,
            proof,
        )
    }

    pub(crate) fn close_before_edit(self) -> Result<()> {
        self.admission.abort()
    }

    pub(crate) fn finish(
        self,
        mut pending: MemberPolicyPending,
        edit: Arc<PreparedMemberPolicyEdit>,
        terminal: MemberPolicyEnd,
    ) -> Result<()> {
        let Self {
            gate, admission, ..
        } = self;
        // The terminal stamp already proves the exact original native effect.
        // Ordinary guards refuse the still-present member pending marker.
        let outcome = admission.finish_result(Ok(())).and_then(|()| {
            match terminal {
                MemberPolicyEnd::Applied(receipt) => pending.release_terminal(&receipt),
                MemberPolicyEnd::Rejected(receipt) => pending.release_rejected(receipt),
            }
            .map_err(Into::into)
        });
        if outcome.is_err() {
            gate.retain_member_policy((pending, edit));
        }
        outcome
    }

    pub(crate) fn retain(
        self,
        pending: MemberPolicyPending,
        edit: Arc<PreparedMemberPolicyEdit>,
    ) -> Result<()> {
        self.gate.retain_member_policy((pending, edit));
        self.admission.abort()
    }
}

impl Inner {
    fn retain_member_policy(&self, pending: RetainedMemberPolicy) {
        let mut retained = self
            .failed_member_policy
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if retained.is_none() {
            *retained = Some(pending);
        }
    }

    pub(super) fn assert_no_failed_member_policy(&self) -> Result<()> {
        need(
            self.failed_member_policy
                .lock()
                .is_ok_and(|retained| retained.is_none()),
            "EMPLOYEE_RESOURCE_RECONCILIATION_REQUIRED",
        )
    }
}
