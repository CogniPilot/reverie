//! Original L envelope DATA. A parsed reference/request cannot grant protected
//! admission, bind a Q operation or construct a canonical launch authority.
use super::*;
use crate::legacy_json::ordered::OrderedValue;
use reverie_core::{ids::NativeOperationId, operations::JournalDigest};

pub struct ProtectedWorkerRequest {
    reference: NativeOperationId,
    request: WorkerRequest,
    request_digest: JournalDigest,
}
impl ProtectedWorkerRequest {
    pub fn decode(raw: &[u8], configuration: &EffectiveWorkerConfig) -> Result<Self> {
        if raw.len() > MAX_REQUEST_FRAME {
            return Err(LaunchDataError::Frame);
        }
        let envelope = crate::legacy_json::decode_worker_request_bytes(raw)
            .map_err(|_| LaunchDataError::Json)?;
        let fields = object(&envelope.value)?;
        if fields.len() != 2
            || field(fields, "reference").is_none()
            || field(fields, "request").is_none()
        {
            return Err(LaunchDataError::Request);
        }
        let reference = NativeOperationId::parse(&scalar(field(fields, "reference"))?)
            .map_err(|_| LaunchDataError::Request)?;
        let index = envelope
            .root_child_index(&key("request"))
            .ok_or(LaunchDataError::Request)?;
        let nested = OrderedValue {
            value: field(fields, "request")
                .ok_or(LaunchDataError::Request)?
                .deep_clone(),
            graph: envelope.graph.with_root(index),
        };
        // Hash the validated incoming request value, before runtime environment
        // injection or any reconstructed publication representation.
        let request = WorkerRequest::from_ordered(nested.clone(), configuration)?;
        let bytes = crate::reservation_control::fingerprint(&nested.value)
            .map_err(|_| LaunchDataError::Request)?;
        let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
        let request_digest = JournalDigest::parse(&hex).map_err(|_| LaunchDataError::Request)?;
        Ok(Self {
            reference,
            request,
            request_digest,
        })
    }
    pub fn reference(&self) -> &NativeOperationId {
        &self.reference
    }
    pub fn request(&self) -> &WorkerRequest {
        &self.request
    }
    pub fn request_digest(&self) -> &JournalDigest {
        &self.request_digest
    }
    pub fn into_parts(self) -> (NativeOperationId, WorkerRequest, JournalDigest) {
        (self.reference, self.request, self.request_digest)
    }
}
