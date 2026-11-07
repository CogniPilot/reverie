//! Exact descriptive scratch-label DATA. It never identifies an authorized
//! caller or grants storage, filesystem, mount or execution permission.
use super::*;
use crate::legacy_json::ordered::OrderedValue;
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ScratchLabelClockError;
impl std::fmt::Display for ScratchLabelClockError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SCRATCH_LABEL_CLOCK")
    }
}
impl std::error::Error for ScratchLabelClockError {}
pub fn scratch_label_bytes(
    employee: Option<&ProfileEmployeeId>,
    session: &ProfileSessionId,
    created_at: f64,
) -> std::result::Result<Vec<u8>, ScratchLabelClockError> {
    if !created_at.is_finite() {
        return Err(ScratchLabelClockError);
    }
    let (owner, identity) = employee.map_or(("ownerSessionId", session.as_str()), |employee| {
        ("ownerEmployeeId", employee.as_str())
    });
    let scalar = |value: &str| OrderedValue::scalar(Value(Node::String(key(value))));
    Ok(OrderedValue::object(vec![
        (key(owner), scalar(identity)),
        (
            key("purpose"),
            scalar("Laptop scratch; release leased tasks with a handoff before pruning"),
        ),
        (
            key("createdAt"),
            OrderedValue::scalar(Value(Node::Number(Number::Float(created_at)))),
        ),
    ])
    .encode())
}
