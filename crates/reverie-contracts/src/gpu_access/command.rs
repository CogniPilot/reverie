use super::*;
use crate::legacy_json;
use reverie_core::{
    decimal::UnsignedInteger,
    gpu_access::{GpuDeviceUuid, GpuExpected, GpuIntent},
    operations::{JournalDigest, JournalId},
};

/// Intentionally unvalidated until the admitted service has read its private
/// current configuration. The old request checks CAS/device shape before Gate
/// acquisition, but checks employee UUID only in `_current` afterward.
pub struct GpuEmployeeSelector(Value);
impl GpuEmployeeSelector {
    pub fn employee_id(&self) -> Result<JournalId> {
        Ok(JournalId::parse(
            &text(&self.0).ok_or_else(|| OperationError::new("UUID"))?,
        )?)
    }
}
pub enum GpuCommand {
    Status(GpuEmployeeSelector),
    Request {
        employee: GpuEmployeeSelector,
        intent: GpuIntent,
    },
}
/// Owner UID authorization belongs to the actual C connection outside this
/// codec. Recursive duplicate refusal, bytes encoding detection and 4300-digit
/// integer behavior reuse the one purpose-aware Python JSON owner.
pub fn decode_command(raw: &[u8]) -> Result<GpuCommand> {
    let value = legacy_json::decode_gpu_control_bytes(raw).map_err(|error| match error {
        legacy_json::GpuControlParseError::Json(legacy_json::Error::DuplicateKey) => {
            GpuDataError::DuplicateKey
        }
        legacy_json::GpuControlParseError::Json(legacy_json::Error::InvalidJson) => {
            GpuDataError::Json
        }
        legacy_json::GpuControlParseError::Nonfinite => GpuDataError::Nonfinite,
    })?;
    let fields = object(&value).ok_or(GpuDataError::RequestSchema)?;
    let action = field(fields, "action").and_then(text);
    if action.as_deref() == Some("gpu-access-status") {
        if !exact(fields, &["action", "employeeId"]) {
            return Err(GpuDataError::RequestSchema);
        }
        return Ok(GpuCommand::Status(selector(fields)?));
    }
    let short = ["action", "employeeId", "expected", "enabled"];
    let long = ["action", "employeeId", "expected", "enabled", "deviceUuid"];
    if action.as_deref() != Some("gpu-access-request")
        || !(exact(fields, &short) || exact(fields, &long))
    {
        return Err(GpuDataError::RequestSchema);
    }
    let expected = expected(field(fields, "expected").ok_or(GpuAccessError::RequestCasSchema)?)?;
    let device = device(fields)?;
    Ok(GpuCommand::Request {
        employee: selector(fields)?,
        intent: GpuIntent::new(expected, device),
    })
}
fn selector(fields: &Object) -> Result<GpuEmployeeSelector> {
    Ok(GpuEmployeeSelector(
        field(fields, "employeeId")
            .ok_or(GpuDataError::RequestSchema)?
            .deep_clone(),
    ))
}
fn expected(value: &Value) -> Result<GpuExpected> {
    let error = || GpuDataError::Core(GpuAccessError::RequestCasSchema);
    let fields = object(value)
        .filter(|fields| {
            exact(
                fields,
                &[
                    "sessionId",
                    "sessionGeneration",
                    "bindingDigest",
                    "revision",
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
    let generation = field(fields, "sessionGeneration")
        .and_then(integer)
        .and_then(UnsignedInteger::parse)
        .ok_or_else(error)?;
    let revision = field(fields, "revision")
        .and_then(integer)
        .and_then(|value| value.parse().ok())
        .ok_or_else(error)?;
    Ok(GpuExpected::try_new(session, generation, digest, revision)?)
}
fn device(fields: &Object) -> Result<Option<GpuDeviceUuid>> {
    match field(fields, "enabled").map(|value| &value.0) {
        Some(Node::Bool(false)) if field(fields, "deviceUuid").is_none() => Ok(None),
        Some(Node::Bool(true)) => {
            let value = field(fields, "deviceUuid")
                .and_then(text)
                .ok_or(GpuAccessError::DeviceSelection)?;
            Ok(Some(GpuDeviceUuid::parse(&value)?))
        }
        _ => Err(GpuAccessError::DeviceSelection.into()),
    }
}
