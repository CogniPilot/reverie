use super::*;
use reverie_core::ids::{ProfileEmployeeId, ProfileSessionId};

/// Configured EID and its one current canonical SID, without owner, generation,
/// retired-registry, running-intent or unrelated-identity gates.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CurrentLeaseSession {
    employee: ProfileEmployeeId,
    session: ProfileSessionId,
}
impl CurrentLeaseSession {
    pub fn employee(&self) -> &ProfileEmployeeId {
        &self.employee
    }
    pub fn session(&self) -> &ProfileSessionId {
        &self.session
    }
}
pub fn select_company(raw: &[u8], employee: &ProfileEmployeeId) -> Result<CurrentLeaseSession> {
    // I.decoded rejects literal constants through parse_constant, but Python's
    // numeric parser still admits exponent overflow. Do not impose all-finite.
    let company = legacy_json::decode_bytes_without_constants(raw)?;
    let company = object(&company).map_err(|_| LeaseDataError::Registry)?;
    let Some(Value(Node::Array(rows))) = field(company, "employees") else {
        return Err(LeaseDataError::Registry);
    };
    let mut selected = None;
    for value in rows {
        let row = object(value).map_err(|_| LeaseDataError::Registry)?;
        let matches = field(row, "id").is_some_and(
            |value| matches!(&value.0,Node::String(value) if value.equals_ascii(employee.as_str())),
        );
        if !matches {
            continue;
        }
        if selected.is_some() {
            return Err(LeaseDataError::EmployeeSelection);
        }
        let value = text(field(row, "sessionId")).map_err(|_| LeaseDataError::Session)?;
        let value: String = value
            .0
            .iter()
            .map(|&value| char::from_u32(value))
            .collect::<Option<_>>()
            .ok_or(LeaseDataError::Session)?;
        selected = Some(ProfileSessionId::parse(&value).map_err(|_| LeaseDataError::Session)?);
    }
    Ok(CurrentLeaseSession {
        employee: employee.clone(),
        session: selected.ok_or(LeaseDataError::EmployeeSelection)?,
    })
}
