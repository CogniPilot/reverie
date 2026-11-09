//! Closed continuation DATA for the same already-owned RAM operation. A
//! reference selects that owner; it never reconstructs approval or custody.
use super::*;
use reverie_core::ids::NativeOperationId;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ResourceContinuationVerb {
    Publication,
    Prepare,
    SourceStop,
    Start,
}
pub struct ResourceContinuationRequest {
    request: JournalId,
    reference: NativeOperationId,
    verb: ResourceContinuationVerb,
}
impl ResourceContinuationRequest {
    pub fn decode(frame: &HumanFrame) -> Result<Self> {
        let value = frame.value();
        closed(value, &["kind", "requestId", "verb", "reference"])?;
        literal(field(value, "kind")?, "resource-operation")?;
        let verb = match scalar(field(value, "verb")?)?.as_str() {
            "publication" => ResourceContinuationVerb::Publication,
            "prepare" => ResourceContinuationVerb::Prepare,
            "source-stop" => ResourceContinuationVerb::SourceStop,
            "start" => ResourceContinuationVerb::Start,
            _ => return Err(ResourceActorDataError("RESOURCE_RAM_CLOSED_CONTINUATION")),
        };
        Ok(Self {
            request: identifier(field(value, "requestId")?)?,
            reference: NativeOperationId::parse(&scalar(field(value, "reference")?)?)
                .map_err(|_| ResourceActorDataError("RESOURCE_RAM_REFERENCE"))?,
            verb,
        })
    }
    pub fn request_id(&self) -> &JournalId {
        &self.request
    }
    pub fn reference(&self) -> &NativeOperationId {
        &self.reference
    }
    pub fn verb(&self) -> ResourceContinuationVerb {
        self.verb
    }
    pub fn require_original(
        &self,
        original: &ResourceOperationRequest,
        reference: &NativeOperationId,
    ) -> Result<()> {
        need(
            matches!(original.selection(), ResourceRequestSelection::Apply { .. })
                && self.request != *original.request_id()
                && &self.reference == reference,
            "RESOURCE_RAM_CONTINUATION_CHANGED",
        )
    }
}
impl ResourceOperationRequest {
    pub fn continuation_owner_challenge(
        &self,
        continuation: &ResourceContinuationRequest,
        nonce: &JournalId,
    ) -> Result<HumanFrame> {
        need(
            matches!(self.selection(), ResourceRequestSelection::Apply { .. }),
            "RAM_APPROVAL_REQUIRED",
        )?;
        self.owner_challenge_at(continuation.request_id(), nonce)
    }
    pub fn parse_continuation_owner_reply(
        &self,
        frame: &HumanFrame,
        continuation: &ResourceContinuationRequest,
        nonce: &JournalId,
    ) -> Result<CurrentResourceOwner> {
        need(
            matches!(self.selection(), ResourceRequestSelection::Apply { .. }),
            "RAM_APPROVAL_REQUIRED",
        )?;
        self.owner_reply_at(
            frame.value(),
            continuation.request_id(),
            nonce,
            "resource-owner-current",
            owner::OWNER_REPLY_FIELDS,
        )
    }
}
