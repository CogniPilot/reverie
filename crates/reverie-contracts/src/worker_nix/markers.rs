use super::*;
use crate::{
    legacy_json::{self, Number},
    storage_identity::Metadata,
};
use reverie_core::ids::{ProfileEmployeeId, ProfileSessionId};

/// Exact v2 candidate. Employee comparison deliberately occurs after the host's
/// fresh storage selection, rather than validating an employee field early.
pub struct NixMigrationMarker {
    employee: Value,
}
impl NixMigrationMarker {
    pub fn capture(marker: &Metadata, session: &ProfileSessionId) -> Result<Self> {
        let fields = object(marker.as_value()).ok_or(NixDataError::Migration)?;
        let exact = fields.len() == 5
            && ["version", "token", "employeeId", "sessionId", "state"]
                .iter()
                .all(|name| field(fields, name).is_some());
        let integer_two = matches!(field(fields,"version"),Some(Value(Node::Number(Number::Integer(value)))) if value=="2");
        let token = string(field(fields, "token")).map_err(|_| NixDataError::Migration)?;
        let token_valid = token.codepoints().len() == 32
            && token
                .codepoints()
                .iter()
                .all(|point| matches!(point, 48..=57 | 97..=102));
        if !exact
            || !integer_two
            || !token_valid
            || !equal_text(field(fields, "sessionId"), session.as_str())
            || !equal_text(field(fields, "state"), "employee-canonical")
        {
            return Err(NixDataError::Migration);
        }
        Ok(Self {
            employee: field(fields, "employeeId")
                .expect("exact fields")
                .deep_clone(),
        })
    }
    pub fn matches_employee(&self, employee: &ProfileEmployeeId) -> bool {
        equal_text(Some(&self.employee), employee.as_str())
    }
}
fn equal_text(value: Option<&Value>, expected: &str) -> bool {
    matches!(value,Some(Value(Node::String(value))) if value.equals_ascii(expected))
}
/// Path.read_text -> default json.loads(str), not the strict metadata decoder:
/// duplicates are last-wins and bool/float values retain Python equality.
pub fn validate_rollback_text(raw: &[u8], session: &ProfileSessionId) -> Result<()> {
    let raw = legacy_json::utf8_file_text(raw).map_err(|_| NixDataError::Json)?;
    let actual = legacy_json::decode_python_str(raw.as_bytes()).map_err(|_| NixDataError::Json)?;
    let expected = Value(Node::Object(
        [
            (
                key("version"),
                Value(Node::Number(Number::Integer("1".into()))),
            ),
            (key("sessionId"), Value(Node::String(key(session.as_str())))),
            (key("legacy"), Value(Node::Bool(true))),
        ]
        .into(),
    ));
    if actual.python_eq(&expected) {
        Ok(())
    } else {
        Err(NixDataError::Rollback)
    }
}
