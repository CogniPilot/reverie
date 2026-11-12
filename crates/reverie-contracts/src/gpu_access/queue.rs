use super::*;
use crate::storage_identity::OrderedMetadata;
use reverie_core::{
    gpu_access::{GpuDeviceUuid, GpuQueuedRequest, GpuRequestDocument},
    operations::{JournalDigest, JournalId},
    revision::Generation,
};

const SCHEMA: &str = "reverie-owner-gpu-requests-v1";
pub fn decode_requests(metadata: &OrderedMetadata) -> Result<GpuRequestDocument> {
    let error = || GpuDataError::Core(GpuAccessError::RequestStore);
    let fields = object(metadata.as_value())
        .filter(|fields| exact(fields, &["schema", "requests"]))
        .ok_or_else(error)?;
    if field(fields, "schema").and_then(text).as_deref() != Some(SCHEMA) {
        return Err(error());
    }
    let rows = field(fields, "requests")
        .and_then(object)
        .ok_or_else(error)?;
    if rows.len() > reverie_core::gpu_access::MAX_REQUESTS {
        return Err(error());
    }
    let mut requests = BTreeMap::new();
    // Python validates the journal's request entries in insertion order. This
    // determines the primary UUID-vs-row-shape refusal when multiple rows fail.
    let order = metadata.object_field_order("requests").ok_or_else(error)?;
    for employee in order {
        let row = rows
            .get(&employee)
            .expect("ordered metadata object invariant");
        let employee = employee
            .0
            .iter()
            .map(|&cp| char::from_u32(cp))
            .collect::<Option<String>>()
            .ok_or_else(|| OperationError::new("UUID"))?;
        let employee = JournalId::parse(&employee)?;
        requests.insert(employee, decode_row(row)?);
    }
    Ok(GpuRequestDocument::try_new(requests)?)
}
pub(crate) fn decode_row(value: &Value) -> Result<GpuQueuedRequest> {
    let error = || GpuDataError::Core(GpuAccessError::RequestStore);
    let fields = object(value)
        .filter(|fields| {
            exact(
                fields,
                &[
                    "revision",
                    "sessionId",
                    "sessionGeneration",
                    "bindingDigest",
                    "deviceUuid",
                ],
            )
        })
        .ok_or_else(error)?;
    let session = JournalId::parse(
        &field(fields, "sessionId")
            .and_then(text)
            .ok_or_else(|| OperationError::new("UUID"))?,
    )?;
    let digest = JournalDigest::parse(
        &field(fields, "bindingDigest")
            .and_then(text)
            .ok_or_else(|| OperationError::new("DIGEST"))?,
    )?;
    let revision = field(fields, "revision")
        .and_then(integer)
        .and_then(|value| value.parse().ok())
        .ok_or_else(error)?;
    let generation = field(fields, "sessionGeneration")
        .and_then(integer)
        .and_then(|value| value.parse().ok())
        .and_then(|value| Generation::try_new(value).ok())
        .ok_or_else(error)?;
    let device = match field(fields, "deviceUuid").map(|value| &value.0) {
        Some(Node::Null) => None,
        Some(Node::String(value)) => Some(
            GpuDeviceUuid::parse(
                &value
                    .0
                    .iter()
                    .map(|&cp| char::from_u32(cp))
                    .collect::<Option<String>>()
                    .ok_or_else(error)?,
            )
            .map_err(|_| error())?,
        ),
        _ => return Err(error()),
    };
    Ok(GpuQueuedRequest::try_new(
        revision, session, generation, digest, device,
    )?)
}
pub(super) fn encode_row(row: &GpuQueuedRequest) -> Value {
    Value(Node::Object(
        [
            (key("revision"), number(row.revision())),
            (key("sessionId"), string(row.session().as_str())),
            (key("sessionGeneration"), number(row.generation().get())),
            (key("bindingDigest"), string(row.digest().as_str())),
            (
                key("deviceUuid"),
                row.device()
                    .map_or(Value(Node::Null), |value| string(value.as_str())),
            ),
        ]
        .into(),
    ))
}
pub fn encode_requests(document: &GpuRequestDocument) -> Vec<u8> {
    let rows = document
        .requests()
        .iter()
        .map(|(employee, row)| (key(employee.as_str()), encode_row(row)))
        .collect();
    crate::worker_config::compact_data(&Value(Node::Object(
        [
            (key("schema"), string(SCHEMA)),
            (key("requests"), Value(Node::Object(rows))),
        ]
        .into(),
    )))
}
