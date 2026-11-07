//! Original Office hook JSON bytes use default Python decoding and last-key
//! wins. Matching this transport session does not grant the downstream action.
use crate::legacy_json::{self, Node, Text};
use reverie_core::ids::ProfileSessionId;
pub fn session_matches(raw: &[u8], session: &ProfileSessionId) -> bool {
    let Ok(value) = legacy_json::decode_rootless_profile(raw) else {
        return false;
    };
    let Node::Object(fields) = &value.0 else {
        return false;
    };
    let key = Text("sessionId".chars().map(u32::from).collect());
    matches!(fields.get(&key).map(|value| &value.0), Some(Node::String(value)) if value.equals_ascii(session.as_str()))
}
