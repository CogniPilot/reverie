use super::*;
use crate::legacy_json;
use reverie_core::operations::*;
use reverie_core::revision::{Generation, ObservedProfileVersion, ProfileVersion, StoreRevision};

fn parsed(raw: &[u8]) -> Result<legacy_json::JournalParsed> {
    need(raw.len() <= MAX_BYTES, "STORE_BOUND")?;
    legacy_json::decode_journal(raw).map_err(|e| match e {
        legacy_json::JournalParseError::Json(legacy_json::Error::DuplicateKey) => {
            error("DUPLICATE_KEY")
        }
        legacy_json::JournalParseError::Json(_) => error("INVALID_LEDGER"),
        legacy_json::JournalParseError::DocumentInteger => error("DOCUMENT_INTEGER"),
        legacy_json::JournalParseError::JsonNumber => error("JSON_NUMBER"),
        legacy_json::JournalParseError::Version => error("VERSION"),
    })
}
pub fn decode(raw: &[u8]) -> Result<OperationDocument> {
    let parsed = parsed(raw)?;
    let fields = exact(&parsed.value, &["schema", "revision", "operations"])?;
    need(
        text(field(fields, "schema")?, "SCHEMA")? == SCHEMA,
        "SCHEMA",
    )?;
    let revision = StoreRevision::try_new(version(field(fields, "revision")?, false)?)
        .map_err(|_| error("VERSION"))?;
    let ops = object(field(fields, "operations")?).map_err(|_| error("OPERATION_LIMIT"))?;
    need(ops.len() <= MAX_OPERATIONS, "OPERATION_LIMIT")?;
    let order = parsed
        .root_object_orders
        .get(&key("operations"))
        .ok_or(error("INVALID_LEDGER"))?;
    let mut builder = OperationDocumentBuilder::new(revision);
    let mut seen = std::collections::BTreeSet::new();
    for name in order {
        let value = ops.get(name).ok_or(error("INVALID_LEDGER"))?;
        let operation = operation(value, name)?;
        let id = operation.data().id.clone();
        super::encode::index_hash(&operation, &mut seen)?;
        builder.push_unique(id, operation)?;
    }
    let document = builder.finish()?;
    super::encode(&document)?;
    Ok(document)
}
pub fn decode_scope(raw: &[u8]) -> Result<OperationScope> {
    scope(&parsed(raw)?.value)
}
pub fn decode_request(raw: &[u8]) -> Result<OperationRequest> {
    request(&parsed(raw)?.value)
}
pub fn decode_observation(raw: &[u8]) -> Result<CapacityObservation> {
    observation(&parsed(raw)?.value)
}
fn id(value: &Value) -> Result<JournalId> {
    JournalId::parse(&text(value, "UUID")?)
}
fn digest(value: &Value) -> Result<JournalDigest> {
    JournalDigest::parse(&text(value, "DIGEST")?)
}
fn scope(value: &Value) -> Result<OperationScope> {
    let f = exact(value, &["owner_scope_digest", "company_id"])?;
    Ok(OperationScope {
        owner_scope_digest: digest(field(f, "owner_scope_digest")?)?,
        company_id: id(field(f, "company_id")?)?,
    })
}
fn profile(value: &Value) -> Result<ObservedProfileVersion> {
    let n = uint(value, false)?;
    ObservedProfileVersion::try_new(n).map_err(|_| error("PROFILE_VERSION"))
}
fn request(value: &Value) -> Result<OperationRequest> {
    let f = exact(
        value,
        &[
            "employee_id",
            "pool_id",
            "source_binding_digest",
            "profile_version",
            "requested_memory_bytes",
            "preview_digest",
            "observation_digest",
        ],
    )?;
    let employee_id = id(field(f, "employee_id")?)?;
    let pool_id = id(field(f, "pool_id")?)?;
    let source_binding_digest = digest(field(f, "source_binding_digest")?)?;
    let preview_digest = digest(field(f, "preview_digest")?)?;
    let observation_digest = digest(field(f, "observation_digest")?)?;
    let profile_version = profile(field(f, "profile_version")?)?;
    let requested_memory_bytes =
        MemoryBytes::try_new(uint(field(f, "requested_memory_bytes")?, true)?)?;
    Ok(OperationRequest {
        employee_id,
        pool_id,
        source_binding_digest,
        profile_version,
        requested_memory_bytes,
        preview_digest,
        observation_digest,
    })
}
fn observation(value: &Value) -> Result<CapacityObservation> {
    let f = exact(
        value,
        &[
            "pool_id",
            "pool_revision_digest",
            "budget_bytes",
            "committed_bytes",
            "employee_id",
            "current_sid",
            "generation",
            "source_binding_digest",
            "profile_version",
            "current_memory_bytes",
        ],
    )?;
    let pool_id = id(field(f, "pool_id")?)?;
    let employee_id = id(field(f, "employee_id")?)?;
    let current_sid = id(field(f, "current_sid")?)?;
    let pool_revision_digest = digest(field(f, "pool_revision_digest")?)?;
    let source_binding_digest = digest(field(f, "source_binding_digest")?)?;
    let generation = Generation::try_new(uint(field(f, "generation")?, true)?)
        .map_err(|_| error("GENERATION"))?;
    let profile_version = profile(field(f, "profile_version")?)?;
    let current_memory_bytes =
        MemoryBytes::try_new(uint(field(f, "current_memory_bytes")?, true)?)?;
    let committed_bytes = uint(field(f, "committed_bytes")?, false)?;
    validate_allocated_commitment(current_memory_bytes, committed_bytes)?;
    let budget_bytes = uint(field(f, "budget_bytes")?, true)?;
    CapacityObservation::try_new(ObservationData {
        pool_id,
        pool_revision_digest,
        budget_bytes,
        committed_bytes,
        employee_id,
        current_sid,
        generation,
        source_binding_digest,
        profile_version,
        current_memory_bytes,
    })
}
fn operation(value: &Value, key: &Text) -> Result<Operation> {
    let f = exact(
        value,
        &[
            "id",
            "scope",
            "idempotency_key",
            "request",
            "request_digest",
            "reservation_id",
            "reserved_sid",
            "observation",
            "delta_bytes",
            "version",
            "state",
            "last_receipt_digest",
            "reason",
        ],
    )?;
    let key = JournalId::parse(&text(&Value(Node::String(key.clone())), "UUID")?)?;
    need(
        text(field(f, "id")?, "OPERATION_ID")?.as_str() == key.as_str(),
        "OPERATION_ID",
    )?;
    let scope = scope(field(f, "scope")?)?;
    let idempotency_key = id(field(f, "idempotency_key")?)?;
    let reservation_id = id(field(f, "reservation_id")?)?;
    let reserved_sid = id(field(f, "reserved_sid")?)?;
    let request = request(field(f, "request")?)?;
    let request_digest = digest(field(f, "request_digest")?)?;
    need(
        super::request_digest(&request) == request_digest,
        "REQUEST_DIGEST",
    )?;
    let observation = observation(field(f, "observation")?)?;
    validate_roles(
        &key,
        &reservation_id,
        &reserved_sid,
        &observation.data().current_sid,
    )?;
    validate_binding(&request, &observation)?;
    need(
        super::observation_digest(&observation) == request.observation_digest,
        "OBSERVATION_DIGEST",
    )?;
    let delta_bytes = uint(field(f, "delta_bytes")?, false)?;
    validate_delta(
        request.requested_memory_bytes,
        observation.data().current_memory_bytes,
        delta_bytes,
    )?;
    let version = ProfileVersion::try_new(version(field(f, "version")?, true)?)
        .map_err(|_| error("VERSION"))?;
    let raw_state = field(f, "state")?;
    let state_code = if matches!(raw_state.0, Node::Array(_) | Node::Object(_)) {
        "INVALID_LEDGER"
    } else {
        "STATE"
    };
    let state = OperationState::parse(&text(raw_state, state_code)?)?;
    let receipt = field(f, "last_receipt_digest")?;
    let reason = field(f, "reason")?;
    validate_phase_shape(
        state,
        version,
        !matches!(receipt.0, Node::Null),
        !matches!(reason.0, Node::Null),
    )?;
    let optional_digest = |value: &Value| {
        if matches!(value.0, Node::Null) {
            Ok(None)
        } else {
            digest(value).map(Some)
        }
    };
    let last_receipt_digest = optional_digest(receipt)?;
    let reason = if matches!(reason.0, Node::Null) {
        None
    } else {
        Some(RecoveryReason::parse(&text(reason, "REASON")?)?)
    };
    let result = Operation::try_new(OperationData {
        id: key.clone(),
        scope,
        idempotency_key,
        request,
        request_digest,
        reservation_id,
        reserved_sid,
        observation,
        delta_bytes,
        version,
        state,
        last_receipt_digest,
        reason,
    })?;
    super::encode::validate_hashes(&result)?;
    Ok(result)
}
