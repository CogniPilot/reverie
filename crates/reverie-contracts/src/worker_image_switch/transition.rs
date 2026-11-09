use super::{ImageDataError, WorkerImageId};
use crate::{
    legacy_json::{Node, Number, Text, Value},
    worker_config::{self, EffectiveWorkerConfig},
};
use reverie_core::operations::{JournalDigest, JournalId};
use serde_json::value::RawValue;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
type Result<T> = std::result::Result<T, ImageDataError>;

/// Frozen image-only bytes and pending correlation DATA. There is no target
/// path, service/admission token, mutator, decoded authorization or retry grant.
pub struct ImagePinTransition {
    before: EffectiveWorkerConfig,
    candidate: EffectiveWorkerConfig,
    before_bytes: Vec<u8>,
    configuration_bytes: Vec<u8>,
    before_digest: JournalDigest,
    after_digest: JournalDigest,
    old_image: WorkerImageId,
    new_image: WorkerImageId,
    value: Value,
    pending_bytes: Vec<u8>,
}
impl ImagePinTransition {
    pub fn prepare(
        raw: &[u8],
        old: &WorkerImageId,
        new: WorkerImageId,
        operation: JournalId,
        preview_digest: JournalDigest,
    ) -> Result<Self> {
        if raw.is_empty() || raw.len() > 1 << 20 {
            return Err(ImageDataError::Bound);
        }
        if old == &new {
            return Err(ImageDataError::Changed);
        }
        // Existing lossless parser owns duplicate/syntax validation. Borrowed
        // RawValue supplies the ORIGINAL token span; no second JSON lexer and
        // no reserialization of any surrounding owner configuration exists.
        let before = worker_config::decode(raw).map_err(|_| ImageDataError::Json)?;
        let candidate_bytes = replace(raw, old, &new)?;
        let candidate =
            worker_config::decode(&candidate_bytes).map_err(|_| ImageDataError::Json)?;
        if !worker_config::image_only_equivalent(&before, &candidate) {
            return Err(ImageDataError::Changed);
        }
        let before_digest = digest(raw);
        let after_digest = digest(&candidate_bytes);
        let pending_bytes=serde_json::to_vec(&serde_json::json!({"version":1,"purpose":"worker-image-switch-v1","operationId":operation.as_str(),"previewDigest":preview_digest.as_str(),"beforeConfigDigest":before_digest.as_str(),"afterConfigDigest":after_digest.as_str(),"oldImage":old.as_str(),"newImage":new.as_str()})).expect("fixed scalar image data");
        let value =
            crate::legacy_json::decode_utf8(&pending_bytes).expect("fixed scalar image data");
        Ok(Self {
            before,
            candidate,
            before_bytes: raw.to_vec(),
            configuration_bytes: candidate_bytes,
            before_digest,
            after_digest,
            old_image: old.clone(),
            new_image: new,
            value,
            pending_bytes,
        })
    }
    pub fn before(&self) -> &EffectiveWorkerConfig {
        &self.before
    }
    pub fn candidate(&self) -> &EffectiveWorkerConfig {
        &self.candidate
    }
    pub fn before_bytes(&self) -> &[u8] {
        &self.before_bytes
    }
    pub fn configuration_bytes(&self) -> &[u8] {
        &self.configuration_bytes
    }
    pub fn before_digest(&self) -> &JournalDigest {
        &self.before_digest
    }
    pub fn after_digest(&self) -> &JournalDigest {
        &self.after_digest
    }
    pub fn old_image(&self) -> &WorkerImageId {
        &self.old_image
    }
    pub fn new_image(&self) -> &WorkerImageId {
        &self.new_image
    }
    pub fn bytes(&self) -> &[u8] {
        &self.pending_bytes
    }
    pub fn matches_metadata(&self, metadata: &crate::storage_identity::OrderedMetadata) -> bool {
        let value = metadata.as_value();
        let Node::Object(fields) = &value.0 else {
            return false;
        };
        let version = Text("version".chars().map(u32::from).collect());
        fields.len() == 8
            && matches!(fields.get(&version),Some(Value(Node::Number(Number::Integer(raw)))) if raw=="1")
            && self.value.python_eq(value)
    }
}
fn digest(raw: &[u8]) -> JournalDigest {
    JournalDigest::parse(&format!("{:x}", Sha256::digest(raw))).expect("SHA256")
}
fn replace(raw: &[u8], old: &WorkerImageId, new: &WorkerImageId) -> Result<Vec<u8>> {
    let fields: BTreeMap<String, &RawValue> =
        serde_json::from_slice(raw).map_err(|_| ImageDataError::Json)?;
    let image = fields.get("image").ok_or(ImageDataError::Image)?;
    let text: String = serde_json::from_str(image.get()).map_err(|_| ImageDataError::Image)?;
    if WorkerImageId::parse(&text)? != *old {
        return Err(ImageDataError::Changed);
    }
    let start = (image.get().as_ptr() as usize)
        .checked_sub(raw.as_ptr() as usize)
        .ok_or(ImageDataError::Span)?;
    let end = start
        .checked_add(image.get().len())
        .ok_or(ImageDataError::Span)?;
    if raw.get(start..end) != Some(image.get().as_bytes()) {
        return Err(ImageDataError::Span);
    }
    let encoded = serde_json::to_vec(new.as_str()).expect("ASCII image pin");
    let mut candidate = Vec::with_capacity(raw.len() + encoded.len());
    candidate.extend_from_slice(&raw[..start]);
    candidate.extend_from_slice(&encoded);
    candidate.extend_from_slice(&raw[end..]);
    Ok(candidate)
}
