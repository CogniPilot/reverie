//! Pass the original broker's controller slot to the atomic tuple publisher.
use super::*;

impl InstallingBroker {
    pub(crate) fn publish_pool(
        &self,
        proof: &crate::reservation_gate::PublishedPool,
        lifecycle: &LaptopLifecycle<'_>,
        context: &mut crate::reservation_observer::ObservationContext,
        binding: &RwLock<reverie_contracts::reservation_control::ControlBinding>,
        controller: &mut Option<ActivatedController>,
    ) -> Result<(), GateError> {
        self.installed.publish_pool(
            proof,
            lifecycle,
            context,
            binding,
            &self.controller,
            controller,
        )
    }
}
