use super::*;
use reverie_core::operations::*;
use sha2::{Digest, Sha256};
fn string(value: impl ToString) -> Value {
    Value(Node::String(Text(
        value.to_string().chars().map(u32::from).collect(),
    )))
}
fn map<const N: usize>(fields: [(&str, Value); N]) -> Value {
    Value(Node::Object(
        fields.into_iter().map(|(k, v)| (key(k), v)).collect(),
    ))
}
fn bytes(value: &Value) -> Vec<u8> {
    crate::worker_config::compact_data(value)
}
fn fingerprint(value: &Value) -> JournalDigest {
    JournalDigest::parse(&crate::digest::hex(&Sha256::digest(bytes(value)).into()))
        .expect("SHA256 is a lowercase digest")
}
pub fn request_digest(value: &OperationRequest) -> JournalDigest {
    fingerprint(&request(value))
}
pub fn observation_digest(value: &CapacityObservation) -> JournalDigest {
    fingerprint(&observation(value))
}
pub fn scope_digest(value: &OperationScope) -> JournalDigest {
    fingerprint(&scope(value))
}
pub fn operation_digest(value: &Operation) -> JournalDigest {
    fingerprint(&operation(value))
}
pub fn encode(document: &OperationDocument) -> Result<Vec<u8>> {
    let mut seen = std::collections::BTreeSet::new();
    for operation in document.operations().values() {
        index_hash(operation, &mut seen)?;
    }
    let ops = Value(Node::Object(
        document
            .operations()
            .iter()
            .map(|(id, op)| (key(id.as_str()), operation(op)))
            .collect(),
    ));
    let root = map([
        ("schema", string(SCHEMA)),
        (
            "revision",
            Value(Node::Number(Number::Integer(
                document.revision().get().to_string(),
            ))),
        ),
        ("operations", ops),
    ]);
    let raw = bytes(&root);
    need(raw.len() <= MAX_BYTES, "STORE_BOUND")?;
    Ok(raw)
}
pub(super) fn index_hash(
    operation: &Operation,
    seen: &mut std::collections::BTreeSet<(JournalDigest, JournalId)>,
) -> Result<()> {
    validate_hashes(operation)?;
    let data = operation.data();
    need(
        seen.insert((scope_digest(&data.scope), data.idempotency_key.clone())),
        "DUPLICATE_IDEMPOTENCY_KEY",
    )
}
pub(super) fn validate_hashes(operation: &Operation) -> Result<()> {
    let data = operation.data();
    need(
        request_digest(&data.request) == data.request_digest,
        "REQUEST_DIGEST",
    )?;
    need(
        observation_digest(&data.observation) == data.request.observation_digest,
        "OBSERVATION_DIGEST",
    )
}
fn scope(v: &OperationScope) -> Value {
    map([
        ("owner_scope_digest", string(v.owner_scope_digest.as_str())),
        ("company_id", string(v.company_id.as_str())),
    ])
}
fn request(v: &OperationRequest) -> Value {
    map([
        ("employee_id", string(v.employee_id.as_str())),
        ("pool_id", string(v.pool_id.as_str())),
        (
            "source_binding_digest",
            string(v.source_binding_digest.as_str()),
        ),
        ("profile_version", string(v.profile_version.get())),
        (
            "requested_memory_bytes",
            string(v.requested_memory_bytes.get()),
        ),
        ("preview_digest", string(v.preview_digest.as_str())),
        ("observation_digest", string(v.observation_digest.as_str())),
    ])
}
fn observation(v: &CapacityObservation) -> Value {
    let v = v.data();
    map([
        ("pool_id", string(v.pool_id.as_str())),
        (
            "pool_revision_digest",
            string(v.pool_revision_digest.as_str()),
        ),
        ("budget_bytes", string(v.budget_bytes)),
        ("committed_bytes", string(v.committed_bytes)),
        ("employee_id", string(v.employee_id.as_str())),
        ("current_sid", string(v.current_sid.as_str())),
        ("generation", string(v.generation.get())),
        (
            "source_binding_digest",
            string(v.source_binding_digest.as_str()),
        ),
        ("profile_version", string(v.profile_version.get())),
        ("current_memory_bytes", string(v.current_memory_bytes.get())),
    ])
}
fn operation(op: &Operation) -> Value {
    let v = op.data();
    map([
        ("id", string(v.id.as_str())),
        ("scope", scope(&v.scope)),
        ("idempotency_key", string(v.idempotency_key.as_str())),
        ("request", request(&v.request)),
        ("request_digest", string(v.request_digest.as_str())),
        ("reservation_id", string(v.reservation_id.as_str())),
        ("reserved_sid", string(v.reserved_sid.as_str())),
        ("observation", observation(&v.observation)),
        ("delta_bytes", string(v.delta_bytes)),
        (
            "version",
            Value(Node::Number(Number::Integer(v.version.get().to_string()))),
        ),
        ("state", string(v.state.name())),
        (
            "last_receipt_digest",
            v.last_receipt_digest
                .as_ref()
                .map(|v| string(v.as_str()))
                .unwrap_or(Value(Node::Null)),
        ),
        (
            "reason",
            v.reason
                .as_ref()
                .map(|v| string(v.as_str()))
                .unwrap_or(Value(Node::Null)),
        ),
    ])
}
