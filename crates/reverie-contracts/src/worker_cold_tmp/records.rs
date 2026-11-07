//! Fixed cold clear record bytes. Encoding data is neither publication nor
//! ownership/admission authority; the actual Host owner selects every value.
use super::*;
use crate::legacy_json::Number;
use reverie_core::ids::{NativeOperationId, ProfileSessionId};
fn text(value: &str) -> Value {
    Value(Node::String(key(value)))
}
fn integer(value: u64) -> Value {
    Value(Node::Number(Number::Integer(value.to_string())))
}
fn record(
    attempt: &NativeOperationId,
    identity: &str,
    session: &ProfileSessionId,
    tmp: (u64, u64),
    count: Option<usize>,
) -> Vec<u8> {
    let mut fields = BTreeMap::from([
        (key("version"), integer(1)),
        (key("attemptId"), text(attempt.as_str())),
        (
            key("state"),
            text(if count.is_some() {
                "COMPLETE"
            } else {
                "ATTEMPT"
            }),
        ),
        (key("identity"), text(identity)),
        (key("sessionId"), text(session.as_str())),
        (key("tmpDevice"), integer(tmp.0)),
        (key("tmpInode"), integer(tmp.1)),
    ]);
    if let Some(count) = count {
        fields.insert(
            key("removedEntries"),
            Value(Node::Number(Number::Integer(count.to_string()))),
        );
    }
    worker_config::encode_data(&Value(Node::Object(fields)))
}
pub fn clear_pending_record(
    attempt: &NativeOperationId,
    identity: &str,
    session: &ProfileSessionId,
    tmp: (u64, u64),
) -> Vec<u8> {
    record(attempt, identity, session, tmp, None)
}
pub fn clear_complete_record(
    attempt: &NativeOperationId,
    identity: &str,
    session: &ProfileSessionId,
    tmp: (u64, u64),
    count: usize,
) -> Vec<u8> {
    record(attempt, identity, session, tmp, Some(count))
}
