//! A fresh routing name belongs to this original Q after actual claim. It is
//! not a durable operation ID, native grant, recreated owner or retry token.
use super::*;
use crate::reservation_gate::RetainedPreparation;

impl AuthenticatedResourceOperation<'_> {
    pub(super) fn retain_reference(&mut self, claim: &RetainedPreparation) -> Result<()> {
        need(
            self.reference.is_none(),
            "RESOURCE_RAM_REFERENCE_ALREADY_MINTED",
        )?;
        let ResourceRequestSelection::Apply {
            employee_id,
            draft_id,
            operation_id,
            reservation_id,
            target_sid,
            ..
        } = self.request.selection()
        else {
            return Err(ResourceActorError::Refused(
                "RESOURCE_RAM_APPROVAL_REQUIRED",
            ));
        };
        let fresh = reverie_host::resource_facts::fresh_owner_nonce()?;
        // No retry loop: entropy failure or any collision retains the whole
        // actual claim/Q failure and cannot be turned into a fresh claim.
        need(
            ![
                employee_id.as_str(),
                draft_id.as_str(),
                operation_id.as_str(),
                reservation_id.as_str(),
                target_sid.as_str(),
                claim.profile().binding().current_session().as_str(),
                self.request.request_id().as_str(),
            ]
            .contains(&fresh.as_str()),
            "RESOURCE_RAM_REFERENCE_COLLISION",
        )?;
        self.reference =
            Some(NativeOperationId::parse(fresh.as_str()).expect("fresh canonical nonce"));
        Ok(())
    }
    pub fn reference(&self) -> Result<&NativeOperationId> {
        self.reference.as_ref().ok_or(ResourceActorError::Refused(
            "RESOURCE_RAM_REFERENCE_REQUIRED",
        ))
    }
}
