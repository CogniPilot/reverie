use super::*;
use legacy_json::ordered::{OrderNode, OrderedValue};
use reverie_core::operations::JournalDigest;
use sha2::{Digest, Sha256};
/// Recipe fingerprint DATA, preserving the original UTF-16BE key order.
/// It cannot select a runtime recipe or authorize a wake operation.
pub fn recipe_digest(raw: &[u8]) -> Result<JournalDigest> {
    let value = legacy_json::decode_ordered_metadata_bytes(raw)
        .map_err(|_| ResumeDataError("RESUME_RECIPE_REQUIRED"))?;
    digest(&value)
}
pub(super) fn digest(value: &OrderedValue) -> Result<JournalDigest> {
    need(
        matches!(value.value.0, Node::Object(_)),
        "RESUME_RECIPE_REQUIRED",
    )?;
    finite(value.value.first_nonfinite())?;
    need(
        crate::worker_config::compact_data(&value.value).len() < 32768,
        "RESUME_RECIPE_REQUIRED",
    )?;
    validate(value)?;
    let bytes = value.encode_utf16_sorted();
    JournalDigest::parse(&crate::digest::hex(&Sha256::digest(bytes).into()))
        .map_err(|_| ResumeDataError("RESUME_RECIPE_REQUIRED"))
}
fn validate(value: &OrderedValue) -> Result<()> {
    let mut pending = vec![(&value.value, value.graph.root, 0)];
    while let Some((item, index, depth)) = pending.pop() {
        need(depth <= 12, "RESUME_RECIPE_BOUND")?;
        match (&item.0, &value.graph.nodes[index]) {
            (Node::Object(fields), OrderNode::Object(order)) => {
                need(fields.len() <= 256, "RESUME_RECIPE_BOUND")?;
                for (key, child) in order.iter().rev() {
                    pending.push((
                        fields.get(key).expect("private JSON order"),
                        *child,
                        depth + 1,
                    ));
                }
            }
            (Node::Null | Node::Bool(_) | Node::String(_), OrderNode::Leaf) => (),
            _ => return Err(ResumeDataError("RESUME_RECIPE_SCALAR")),
        }
    }
    Ok(())
}
