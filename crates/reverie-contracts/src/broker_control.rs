//! Legacy broker C-frame routing, in the exact order of the legacy handler's
//! checks. This classifies a request; it authorizes nothing, checks no peer
//! and performs no effect. Each route's owner validates its own fields.
#[cfg(test)]
mod tests;
use crate::legacy_json::{self, Node, Number, Text, Value};
use std::collections::BTreeMap;

/// The host-recovery actions that only the fixed owner channel may carry.
pub const RESUME_ACTIONS: [&str; 4] = [
    "worker-resume-describe",
    "prepare-worker-resume",
    "apply-worker-resume",
    "worker-resume-status",
];
const PERF_ACTIONS: [&str; 4] = [
    "perf-policy-status",
    "perf-policy-request",
    "perf-policy-preview",
    "perf-policy-apply",
];
const GPU_ACTIONS: [&str; 2] = ["gpu-access-status", "gpu-access-request"];

/// A request field passed through to its owner, which checks its type.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ControlField {
    Null,
    Text(String),
    Integer(String),
    /// Booleans, floats, containers and text with a lone surrogate.
    Other,
}

#[derive(Debug, Eq, PartialEq)]
pub enum ControlRoute {
    /// The owner still requires host recovery and the exact closed payload.
    ResumeChannel,
    /// The perf owner re-decodes the payload and checks the host peer.
    PerfPolicy,
    /// The GPU owner re-decodes the payload.
    GpuAccess,
    SettleStop {
        session: ControlField,
        fence: ControlField,
    },
    StopAgent {
        session: ControlField,
        not_after: Option<ControlField>,
        fence: Option<ControlField>,
    },
    /// status, provider-health, stop-laptops, shutdown, restart-website,
    /// reload-resources and unknown actions; the power owner decides.
    Power {
        action: ControlField,
        caller: Option<ControlField>,
    },
}

#[derive(Debug, Eq, PartialEq)]
pub enum ControlRefusal {
    /// A legacy refusal text, sent as the E payload.
    Message(&'static str),
    /// A non-refusal failure: the fixed transport E text.
    Transport,
    /// The payload is not JSON. The legacy handler sends the JSON decoder's
    /// own message here; this native route sends a fixed refusal instead.
    InvalidJson,
}

/// Classify one C payload as `json.loads(bytes)` (last duplicate wins) and
/// the legacy handler's ordered checks would.
pub fn route(raw: &[u8]) -> Result<ControlRoute, ControlRefusal> {
    let value = legacy_json::decode_broker_control(raw).map_err(|_| ControlRefusal::InvalidJson)?;
    let fields = match &value.0 {
        Node::Object(fields) => Some(fields),
        _ => None,
    };
    let action = fields.and_then(|f| f.get(&key("action")));
    if let Some(action) = action {
        if is_text(action, "worker-resume-channel") {
            return Ok(ControlRoute::ResumeChannel);
        }
        // Set membership hashes the value: an array or object raises.
        if matches!(action.0, Node::Array(_) | Node::Object(_)) {
            return Err(ControlRefusal::Transport);
        }
        if RESUME_ACTIONS.iter().any(|name| is_text(action, name)) {
            return Err(ControlRefusal::Message(
                "Native host recovery requires its fixed owner channel",
            ));
        }
        if PERF_ACTIONS.iter().any(|name| is_text(action, name)) {
            return Ok(ControlRoute::PerfPolicy);
        }
        if GPU_ACTIONS.iter().any(|name| is_text(action, name)) {
            return Ok(ControlRoute::GpuAccess);
        }
    }
    if let (Some(fields), Some(action)) = (fields, action) {
        if is_text(action, "settle-stop") {
            if !keys_are(fields, &["action", "sessionId", "fence"]) {
                return Err(ControlRefusal::Message("Invalid settle-stop request"));
            }
            return Ok(ControlRoute::SettleStop {
                session: field(fields, "sessionId"),
                fence: field(fields, "fence"),
            });
        }
        if is_text(action, "stop-agent") {
            let shape = [
                &["action", "sessionId"][..],
                &["action", "sessionId", "notAfter"][..],
                &["action", "sessionId", "notAfter", "fence"][..],
            ];
            if !shape.iter().any(|keys| keys_are(fields, keys)) {
                return Err(ControlRefusal::Message("Invalid stop-agent request"));
            }
            return Ok(ControlRoute::StopAgent {
                session: field(fields, "sessionId"),
                not_after: fields.get(&key("notAfter")).map(project),
                fence: fields.get(&key("fence")).map(project),
            });
        }
        if is_text(action, "provider-health") && !keys_are(fields, &["action"]) {
            return Err(ControlRefusal::Message(
                "Closed read-only provider health request required",
            ));
        }
    }
    let Some(fields) = fields else {
        return Err(ControlRefusal::Message("Invalid office power request"));
    };
    let allowed = [key("action"), key("caller")];
    if fields.keys().any(|name| !allowed.contains(name)) {
        return Err(ControlRefusal::Message("Invalid office power request"));
    }
    // `control['action']` on a dict without it raises KeyError.
    let Some(action) = action else {
        return Err(ControlRefusal::Transport);
    };
    // `control.get('caller')` reads JSON null as absent.
    let caller = fields
        .get(&key("caller"))
        .map(project)
        .filter(|caller| *caller != ControlField::Null);
    Ok(ControlRoute::Power {
        action: project(action),
        caller,
    })
}
fn key(name: &str) -> Text {
    Text(name.chars().map(u32::from).collect())
}
fn is_text(value: &Value, expected: &str) -> bool {
    matches!(&value.0, Node::String(text) if text.equals_ascii(expected))
}
fn keys_are(fields: &BTreeMap<Text, Value>, expected: &[&str]) -> bool {
    fields.len() == expected.len() && expected.iter().all(|name| fields.contains_key(&key(name)))
}
fn field(fields: &BTreeMap<Text, Value>, name: &str) -> ControlField {
    fields.get(&key(name)).map_or(ControlField::Null, project)
}
fn project(value: &Value) -> ControlField {
    match &value.0 {
        Node::Null => ControlField::Null,
        Node::String(text) => text
            .0
            .iter()
            .map(|&cp| char::from_u32(cp))
            .collect::<Option<String>>()
            .map_or(ControlField::Other, ControlField::Text),
        Node::Number(Number::Integer(digits)) => ControlField::Integer(digits.clone()),
        _ => ControlField::Other,
    }
}
