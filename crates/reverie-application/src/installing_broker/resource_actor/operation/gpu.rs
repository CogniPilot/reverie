//! One explicit GPU observation or queue request on the original qualified Q.
use super::*;

impl AuthenticatedResourceOperation<'_> {
    pub(in crate::installing_broker::resource_actor) fn gpu_reply(&mut self) -> Result<HumanFrame> {
        self.assert_current()?;
        let broker = self.website.frame.broker;
        let gate = broker
            .resource_reservations()?
            .ok_or(ResourceActorError::Refused("RESOURCE_ACTOR_GATE_REQUIRED"))?;
        let result = gate
            .gpu_website_command(self, &broker.storage.runtime)
            .map_err(Into::into);
        let status = self.website.frame.retain_stateless_result(result)?;
        self.assert_current()?;
        Ok(self.request().gpu_result_reply(&status)?)
    }
}
