//! The original protected frame follows its actual actor receipt across CAS.
use super::*;

impl AuthenticatedResourceOperation<'_> {
    pub(crate) fn prepare_gpu_actor_rebind(
        &mut self,
        gate: &ReservationGate,
        before: &Arc<ValidatedWorkerSnapshot>,
        intent: &GpuTransitionIntent,
    ) -> std::result::Result<ActorRebindPlan, GateError> {
        self.assert_reservation_gate(gate).map_err(gpu_check)?;
        let frame = &mut self.website.frame;
        if !matches!(
            self.request.selection(),
            ResourceRequestSelection::GpuApply { .. }
        ) || !frame
            .snapshot
            .as_ref()
            .is_some_and(|original| Arc::ptr_eq(original, before))
        {
            return Err(GateError::Refused("GPU_ACTOR_CONFIGURATION_CHANGED"));
        }
        frame
            .private
            .prepare_configuration_rebind(intent.before(), intent.after())
            .map_err(native_rebind)
    }
    pub(crate) fn assert_gpu_actor_rebound(
        &mut self,
        before: &Arc<ValidatedWorkerSnapshot>,
        after: &Arc<ValidatedWorkerSnapshot>,
        receipt: &GpuActorPublication,
        end: Instant,
    ) -> Result<()> {
        let end = end.min(receipt.deadline());
        self.assert_gpu_rebound_metadata(before, after, receipt, end)?;
        self.website.frame.guard_peer_observations(end)?;
        self.assert_gpu_rebound_metadata(before, after, receipt, end)
    }
    fn assert_gpu_rebound_metadata(
        &self,
        before: &Arc<ValidatedWorkerSnapshot>,
        after: &Arc<ValidatedWorkerSnapshot>,
        receipt: &GpuActorPublication,
        end: Instant,
    ) -> Result<()> {
        receipt.assert_current().map_err(GateError::from)?;
        let frame = &self.website.frame;
        let original = frame.assert_configuration_owner(end)?;
        if !Arc::ptr_eq(original, before) || before.source_path() != after.source_path() {
            return Err(ResourceActorError::Refused(
                "GPU_ACTOR_CONFIGURATION_CHANGED",
            ));
        }
        frame
            .private
            .assert_configuration_rebind(receipt.actor(), after.configuration())?;
        self.assert_owner_channel_live()
    }
    pub(crate) fn accept_gpu_actor_rebound(
        &mut self,
        before: &Arc<ValidatedWorkerSnapshot>,
        after: &Arc<ValidatedWorkerSnapshot>,
        receipt: &GpuActorPublication,
    ) -> std::result::Result<(), GateError> {
        receipt.assert_current()?;
        self.website
            .frame
            .accept_actor_rebind(before, after, receipt.actor())
            .map_err(gpu_check)
    }
}
fn native_rebind(cause: ResourceFactsError) -> GateError {
    GpuHostError::ActorRebind(Box::new(cause)).into()
}
fn gpu_check(cause: ResourceActorError) -> GateError {
    match cause {
        ResourceActorError::Private(error) => native_rebind(error),
        ResourceActorError::Gate(error) => *error,
        ResourceActorError::Channel(error) => GateError::Actor(Box::new(error.into())),
        other => GateError::Refused(other.code()),
    }
}
