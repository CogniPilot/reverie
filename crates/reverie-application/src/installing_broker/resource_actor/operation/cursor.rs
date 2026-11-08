//! The actual original Q channel owns its bounded continuation cursor. IDs
//! correlate this owner; no cursor constructs a claim or authorizes a launch.
use super::*;
use reverie_core::operations::JournalId;
#[cfg(test)]
mod tests;

#[derive(Default)]
pub(super) struct OperationCursor {
    current: Option<ResourceContinuationRequest>,
    seen: Vec<JournalId>,
}
impl OperationCursor {
    pub(super) fn current(&self) -> Option<&ResourceContinuationRequest> {
        self.current.as_ref()
    }
    fn accept(
        &mut self,
        next: ResourceContinuationRequest,
        original: &ResourceOperationRequest,
        reference: &NativeOperationId,
        expected: ResourceContinuationVerb,
    ) -> Result<()> {
        const ORDER: [ResourceContinuationVerb; 4] = [
            ResourceContinuationVerb::Publication,
            ResourceContinuationVerb::Prepare,
            ResourceContinuationVerb::SourceStop,
            ResourceContinuationVerb::Start,
        ];
        next.require_original(original, reference)?;
        need(
            ORDER.get(self.seen.len()) == Some(&expected)
                && next.verb() == expected
                && next.request_id().as_str() != reference.as_str()
                && !self.seen.contains(next.request_id()),
            "RESOURCE_RAM_CONTINUATION_ORDER",
        )?;
        // Latch before any fallible nonce/company/native work. Failed phases
        // remain inside the original whole owner, never a replayable cursor.
        self.seen.push(next.request_id().clone());
        self.current = Some(next);
        Ok(())
    }
}
impl AuthenticatedResourceOperation<'_> {
    pub(super) fn receive_continuation(
        &mut self,
        expected: ResourceContinuationVerb,
    ) -> Result<()> {
        let result = (|| {
            self.assert_live()?;
            let frame = &mut self.website.frame;
            let end = frame.deadline.min(Instant::now() + Duration::from_secs(5));
            let next = ResourceContinuationRequest::decode(&frame.receive(end)?)?;
            let reference = self.reference.as_ref().ok_or(ResourceActorError::Refused(
                "RESOURCE_RAM_REFERENCE_REQUIRED",
            ))?;
            self.cursor
                .accept(next, &self.request, reference, expected)?;
            self.assert_current()
        })();
        self.website.frame.failed |= result.is_err();
        result
    }
    pub(super) fn assert_launch_command(&mut self, selected: &RamLaunchCommandData) -> Result<()> {
        let result = self.launch_command(selected);
        self.website.frame.failed |= result.is_err();
        result
    }
    fn launch_command(&mut self, selected: &RamLaunchCommandData) -> Result<()> {
        let next = self.cursor.current().ok_or(ResourceActorError::Refused(
            "RESOURCE_RAM_START_CONTINUATION_REQUIRED",
        ))?;
        let frame = &mut self.website.frame;
        let end = frame.deadline.min(Instant::now() + Duration::from_secs(5));
        frame.guard_bootstrap(end)?;
        self.checks += 1;
        need(self.checks <= 256, "RESOURCE_ACTOR_CHALLENGE_BOUND")?;
        let nonce = reverie_host::resource_facts::fresh_owner_nonce()?;
        frame.send(
            &self.request.command_challenge(next, selected, &nonce)?,
            end,
        )?;
        let current =
            self.request
                .parse_command_reply(&frame.receive(end)?, next, selected, &nonce)?;
        self.validate_owner(current)
    }
}
