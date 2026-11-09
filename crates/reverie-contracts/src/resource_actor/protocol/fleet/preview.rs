//! Fleet read selection and fresh viewer echo DATA, never maintenance consent.
use super::*;
use crate::worker_pool::WorkerPoolPolicy;
mod owner;
pub use owner::CurrentFleetPreviewViewer;

pub struct FleetPreviewRequest {
    request: JournalId,
    principal: ResourceOwnerPrincipal,
}
impl FleetPreviewRequest {
    pub fn decode(frame: &HumanFrame) -> Result<Self> {
        let value = frame.value();
        closed(
            value,
            &["kind", "purpose", "version", "requestId", "principal"],
        )?;
        literal(field(value, "kind")?, "fleet-preview")?;
        purpose_version(value)?;
        Ok(Self {
            request: identifier(field(value, "requestId")?)?,
            principal: ResourceOwnerPrincipal::capture(field(value, "principal")?)?,
        })
    }
    pub fn request_id(&self) -> &JournalId {
        &self.request
    }
    pub fn principal(&self) -> &ResourceOwnerPrincipal {
        &self.principal
    }
    pub fn owner_challenge(&self, nonce: &JournalId) -> Result<HumanFrame> {
        let mut fields = envelope_fields("fleet-preview-owner-check", &self.request);
        fields.extend([
            (key("principal"), self.principal.value()),
            (key("nonce"), string(nonce.as_str())),
        ]);
        frame(Value(Node::Object(fields)))
    }
    /// Display the native producer's unchanged selection. The literal status
    /// cannot represent qualified artifacts, consent or permission to apply.
    pub fn observed_reply(
        &self,
        selected: &PoolTransitionSelection,
        policy: &WorkerPoolPolicy,
        expires: u64,
    ) -> Result<HumanFrame> {
        need(
            expires > 0 && expires <= reverie_core::revision::JS_SAFE_MAX,
            "FLEET_PREVIEW_EXPIRY",
        )?;
        policy
            .validate()
            .map_err(|_| ResourceActorDataError("FLEET_PREVIEW_POLICY"))?;
        let raw = serde_json::to_vec(policy)
            .map_err(|_| ResourceActorDataError("FLEET_PREVIEW_POLICY"))?;
        let policy = HumanFrame::decode(&raw).map_err(frame_error)?;
        let mut fields = envelope_fields("fleet-preview", &self.request);
        fields.extend([
            (key("approval"), selected.approval_value()),
            (key("policy"), policy.value().deep_clone()),
            (key("status"), string("target-verification-required")),
            (
                key("expiresAtEpochMs"),
                Value(Node::Number(Number::Integer(expires.to_string()))),
            ),
        ]);
        frame(Value(Node::Object(fields)))
    }
}
