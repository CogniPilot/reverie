//! Existing Office plan decision/capability wire. A checked document is DATA;
//! the console still owns current authorization, binding, expiry and replay.
use crate::legacy_json::{self, Node, Text, Value};
use reverie_core::{PythonTextRef, ids::ProfileSessionId};
#[cfg(test)]
mod tests;
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PlanApprovalError;
pub struct PlanDecision {
    request: String,
    handoff: Option<String>,
}
pub fn is_plan_decision(path: &str) -> bool {
    decision(path).is_some()
}
fn decision(path: &str) -> Option<(&str, bool)> {
    let (id, action) = path.strip_prefix("/api/plans/requests/")?.split_once('/')?;
    if id.is_empty()
        || id.len() > 100
        || !id.as_bytes()[0].is_ascii_alphanumeric()
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return None;
    }
    match action {
        "approve" => Some((id, true)),
        "reject" => Some((id, false)),
        _ => None,
    }
}
impl PlanDecision {
    pub fn decode(
        method: &str,
        path: &str,
        query: bool,
        raw: &[u8],
    ) -> Result<Self, PlanApprovalError> {
        if method != "POST" || query || raw.len() > 64 * 1024 {
            return Err(PlanApprovalError);
        }
        let (request, approve) = decision(path).ok_or(PlanApprovalError)?;
        let value = legacy_json::decode_engine_stopped(raw).map_err(|_| PlanApprovalError)?;
        let Node::Object(fields) = &value.0 else {
            return Err(PlanApprovalError);
        };
        let handoff = if approve {
            if fields.len() != 1 {
                return Err(PlanApprovalError);
            }
            let Some(Value(Node::String(text))) = fields.get(&key("handoff")) else {
                return Err(PlanApprovalError);
            };
            let text = PythonTextRef::from_codepoints(&text.0).map_err(|_| PlanApprovalError)?;
            let length = text.trimmed().codepoints().len();
            if !(1..=12000).contains(&length)
                || text
                    .codepoints()
                    .iter()
                    .any(|&cp| matches!(cp, 0..=8 | 11 | 12 | 14..=31 | 127))
            {
                return Err(PlanApprovalError);
            }
            Some(text.scalar_text().ok_or(PlanApprovalError)?.into_owned())
        } else {
            if !fields.is_empty() {
                return Err(PlanApprovalError);
            }
            None
        };
        Ok(Self {
            request: request.into(),
            handoff,
        })
    }
    pub fn request_id(&self) -> &str {
        &self.request
    }
    /// Only the host's purpose-specific no-follow reader supplies these bytes.
    /// This neither consumes the capability nor decides the API permission.
    pub fn attach_capability(
        &self,
        session: &ProfileSessionId,
        raw: &[u8],
    ) -> Result<Vec<u8>, PlanApprovalError> {
        if raw.len() > 4096 {
            return Err(PlanApprovalError);
        }
        let value = legacy_json::decode_engine_stopped(raw).map_err(|_| PlanApprovalError)?;
        let Node::Object(fields) = &value.0 else {
            return Err(PlanApprovalError);
        };
        if fields.len() != 3
            || !text_is(fields.get(&key("requestId")), &self.request)
            || !text_is(fields.get(&key("sessionId")), session.as_str())
        {
            return Err(PlanApprovalError);
        }
        let Some(Value(Node::String(nonce))) = fields.get(&key("nonce")) else {
            return Err(PlanApprovalError);
        };
        if nonce.0.len() != 64 || !nonce.0.iter().all(|&cp| matches!(cp, 48..=57 | 97..=102)) {
            return Err(PlanApprovalError);
        }
        let nonce: String = nonce
            .0
            .iter()
            .map(|&cp| char::from_u32(cp).expect("ASCII nonce"))
            .collect();
        let mut output = serde_json::Map::new();
        if let Some(handoff) = &self.handoff {
            output.insert("handoff".into(), handoff.clone().into());
        }
        output.insert("nonce".into(), nonce.into());
        serde_json::to_vec(&output).map_err(|_| PlanApprovalError)
    }
}
fn key(text: &str) -> Text {
    Text(text.chars().map(u32::from).collect())
}
fn text_is(value: Option<&Value>, expected: &str) -> bool {
    matches!(value, Some(Value(Node::String(text))) if text.equals_ascii(expected))
}
