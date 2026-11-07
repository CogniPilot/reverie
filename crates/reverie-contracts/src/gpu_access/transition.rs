use super::*;
use crate::{
    reservation_control::{self, ControlBinding},
    worker_config::EffectiveWorkerConfig,
};
use reverie_core::{gpu_access::GpuQueuedRequest, operations::JournalId};

/// Complete finite GPU-only publication DATA. This does not prove that either
/// file was written and cannot be supplied to the installing RAM publisher as
/// a permission. Only the real native pending/CAS owner produces that handoff.
pub struct GpuTransitionIntent {
    before: EffectiveWorkerConfig,
    after: EffectiveWorkerConfig,
    before_binding: ControlBinding,
    after_binding: ControlBinding,
    bytes: Vec<u8>,
    value: Value,
}
impl GpuTransitionIntent {
    /// Call at the source intent phase, after worker validation, peer hashes,
    /// binding/native/CDI rechecks. Fingerprint failure must retain its original
    /// position before any durable pending publication.
    pub fn capture(
        candidate: &GpuCandidate,
        employee: &JournalId,
        request: &GpuQueuedRequest,
        binding: &ControlBinding,
    ) -> Result<Self> {
        if reservation_control::domain_digest(candidate.before())? != *binding.domain() {
            return Err(crate::reservation_control::ControlDataError::DomainChanged.into());
        }
        let before = reservation_control::fingerprint(candidate.before().as_value())?;
        let after = reservation_control::fingerprint(candidate.after().as_value())?;
        let next = binding.gpu_rebound(candidate.after())?;
        let value = Value(Node::Object(
            [
                (key("schema"), string("reverie-owner-gpu-transition-v1")),
                (key("employeeId"), string(employee.as_str())),
                (key("request"), queue::encode_row(request)),
                (key("beforeDigest"), string(&crate::digest::hex(&before))),
                (key("afterDigest"), string(&crate::digest::hex(&after))),
                (key("beforeBinding"), binding.gpu_data()),
                (key("afterBinding"), next.gpu_data()),
            ]
            .into(),
        ));
        let bytes = crate::worker_config::compact_data(&value);
        Ok(Self {
            before: candidate.before().clone(),
            after: candidate.after().clone(),
            before_binding: binding.clone(),
            after_binding: next,
            bytes,
            value,
        })
    }
    pub fn before(&self) -> &EffectiveWorkerConfig {
        &self.before
    }
    pub fn after(&self) -> &EffectiveWorkerConfig {
        &self.after
    }
    pub fn before_binding(&self) -> &ControlBinding {
        &self.before_binding
    }
    pub fn after_binding(&self) -> &ControlBinding {
        &self.after_binding
    }
    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }
    pub fn matches_metadata(&self, metadata: &crate::storage_identity::OrderedMetadata) -> bool {
        self.value.python_eq(metadata.as_value())
    }
    pub fn configuration_bytes(&self) -> Vec<u8> {
        crate::worker_config::compact_data(self.after.as_value())
    }
    pub fn binding_bytes(&self) -> Vec<u8> {
        crate::worker_config::compact_data(&self.after_binding.gpu_data())
    }
}
