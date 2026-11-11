//! One explicit GPU observation or queue request on the original qualified Q.
use super::*;
use crate::reservation_gate::ReservationGate;
use reverie_contracts::gpu_access::GpuTransitionIntent;
use reverie_host::{
    gpu_access::{GpuActorPublication, GpuHostError},
    resource_facts::{ActorRebindPlan, ResourceFactsError},
};
mod rebind;

impl AuthenticatedResourceOperation<'_> {
    pub(in crate::installing_broker::resource_actor) fn gpu_reply(&mut self) -> Result<HumanFrame> {
        self.assert_current()?;
        let broker = self.website.frame.broker;
        let gate = broker
            .resource_reservations()?
            .ok_or(ResourceActorError::Refused("RESOURCE_ACTOR_GATE_REQUIRED"))?;
        let result = if matches!(
            self.request().selection(),
            ResourceRequestSelection::GpuApply { .. }
        ) {
            gate.gpu_website_apply(self, &broker.storage.runtime)
        } else {
            gate.gpu_website_command(self, &broker.storage.runtime)
                .map_err(Into::into)
        };
        let (status, can_apply) = self.website.frame.retain_stateless_result(result)?;
        self.assert_current()?;
        Ok(self.request().gpu_result_reply(&status, can_apply)?)
    }
}
