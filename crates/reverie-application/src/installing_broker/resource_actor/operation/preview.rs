use super::*;
impl AuthenticatedResourceOperation<'_> {
    pub(crate) fn ram_admission_bounds(
        &self,
        gate: &crate::reservation_gate::ReservationGate,
    ) -> Result<crate::reservation_gate::AdmissionBounds> {
        self.assert_reservation_gate(gate)?;
        let frame = &self.website.frame;
        let end = frame
            .broker
            .storage
            .runtime
            .stop_budget()
            .deadline()
            .map_or(frame.deadline, |stop| frame.deadline.min(stop));
        Ok(crate::reservation_gate::AdmissionBounds {
            entry: Some(end),
            operation: Some(end),
        })
    }
    pub(in crate::installing_broker::resource_actor) fn close_for_worker(
        &mut self,
    ) -> Result<WorkerLaunchClose> {
        let frame = &mut self.website.frame;
        let end = frame
            .broker
            .storage
            .runtime
            .stop_budget()
            .deadline()
            .map_or(frame.deadline, |stop| frame.deadline.min(stop));
        frame.close(end)
    }
    pub(in crate::installing_broker::resource_actor) fn preview_reply(
        &mut self,
    ) -> Result<HumanFrame> {
        // Full native/current-owner exchanges occur outside admission. The
        // actual Gate uses adjacent metadata/peer/expiry checks at its writes.
        self.assert_current()?;
        let broker = self.website.frame.broker;
        let gate = broker
            .resource_reservations()?
            .ok_or(ResourceActorError::Refused("RESOURCE_ACTOR_GATE_REQUIRED"))?;
        let observed = gate.draft_ram_operation(self).map_err(Into::into);
        let ram = self.website.frame.retain_stateless_result(observed)?;
        self.assert_current()?;
        let preview = ram.preview();
        Ok(self.request.preview_reply(RamPreviewFields {
            draft_id: &preview.draft_id(),
            operation_id: &preview.operation_id(),
            reservation_id: &preview.reservation_id(),
            profile: preview.profile(),
            preview_digest: &preview.digest(),
            ram_policy: ram.policy(),
            source_memory_mib: preview.source_memory_mib(),
        })?)
    }
    pub(in crate::installing_broker::resource_actor) fn send_operation_reply(
        &mut self,
        reply: &HumanFrame,
    ) -> Result<()> {
        self.assert_live()?;
        let end = self
            .website
            .frame
            .deadline
            .min(Instant::now() + Duration::from_secs(5));
        self.website.frame.send(reply, end)
    }
}
