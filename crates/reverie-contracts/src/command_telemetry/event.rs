use super::{Result, TelemetryDataError};
use crate::legacy_json::{self, Node, Number, Text, Value};
use reverie_core::{
    command_telemetry::{
        FAILURE_PROVENANCE, FailureEvent, FailureExit, FailureReport, FailureTool,
    },
    ids::ProfileSessionId,
    worker_options::TelemetryKey,
};
/// The Office constructor owns SID; event data cannot select employee, path,
/// harness, category or time. Byte/duplicate/default-number policy is source's.
pub fn decode_event(raw: &[u8], keys: &[TelemetryKey]) -> Result<FailureEvent> {
    if raw.len() > 512 {
        return Err(TelemetryDataError::Event);
    }
    let value = legacy_json::decode_metadata_bytes(raw).map_err(|_| TelemetryDataError::Event)?;
    let Node::Object(fields) = &value.0 else {
        return Err(TelemetryDataError::Event);
    };
    if fields.len() != 4 {
        return Err(TelemetryDataError::Event);
    }
    let field = |name: &str| {
        fields
            .get(&Text(name.chars().map(u32::from).collect()))
            .ok_or(TelemetryDataError::Event)
    };
    let Node::Number(Number::Integer(version)) = &field("v")?.0 else {
        return Err(TelemetryDataError::Event);
    };
    if version != "1" {
        return Err(TelemetryDataError::Event);
    }
    let string = |value: &Value| {
        if let Node::String(value) = &value.0 {
            value
                .0
                .iter()
                .map(|&cp| char::from_u32(cp))
                .collect::<Option<String>>()
        } else {
            None
        }
    };
    let tool = string(field("tool")?)
        .and_then(|value| FailureTool::parse(&value))
        .filter(|tool| tool.selected(keys))
        .ok_or(TelemetryDataError::Event)?;
    let Node::Number(Number::Integer(exit)) = &field("exit_code")?.0 else {
        return Err(TelemetryDataError::Event);
    };
    let exit = exit
        .parse::<i16>()
        .ok()
        .and_then(FailureExit::try_new)
        .ok_or(TelemetryDataError::Event)?;
    let execution = string(field("execution_id")?)
        .and_then(|value| ProfileSessionId::parse(&value).ok())
        .ok_or(TelemetryDataError::Event)?;
    Ok(FailureEvent::new(execution, tool, exit))
}
/// Exact legacy hands report key order, with only checked fixed ASCII data.
pub fn encode_report(report: &FailureReport) -> Vec<u8> {
    format!("{{\"v\":1,\"employee_id\":\"{}\",\"harness\":\"hands\",\"counts\":[{}],\"evicted\":{},\"expired\":{},\"dropped\":{},\"provenance\":\"{FAILURE_PROVENANCE}\"}}",report.employee().as_str(),report.counts().iter().map(super::report::count_json).collect::<Vec<_>>().join(","),report.evicted(),report.expired(),report.dropped()).into_bytes()
}
