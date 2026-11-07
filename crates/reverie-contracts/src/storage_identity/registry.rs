use super::*;
use std::collections::BTreeSet;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RegistryEmployee {
    identity: MetadataText,
    session: Option<MetadataText>,
    owner: Option<MetadataText>,
}
impl RegistryEmployee {
    pub fn identity(&self) -> &MetadataText {
        &self.identity
    }
    pub fn canonical_identity(&self) -> Result<ProfileEmployeeId> {
        employee_id(&self.identity)
    }
    pub fn owner(&self) -> &Option<MetadataText> {
        &self.owner
    }
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CompanyRecords {
    records: Vec<RegistryEmployee>,
}
impl CompanyRecords {
    pub fn records(&self) -> &[RegistryEmployee] {
        &self.records
    }
    pub fn by_session(&self, session: &ProfileSessionId) -> Option<&RegistryEmployee> {
        self.records.iter().find(|row| {
            row.session
                .as_ref()
                .is_some_and(|value| value.equals_ascii(session.as_str()))
        })
    }
    pub fn by_binding(
        &self,
        identity: &ProfileEmployeeId,
        owner: &Option<MetadataText>,
    ) -> Option<&RegistryEmployee> {
        self.records
            .iter()
            .find(|row| row.identity.equals_ascii(identity.as_str()) && &row.owner == owner)
    }
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CurrentEmployee {
    identity: ProfileEmployeeId,
    session: ProfileSessionId,
    owner: Option<MetadataText>,
    generation: EmployeeGeneration,
}
impl CurrentEmployee {
    pub fn identity(&self) -> &ProfileEmployeeId {
        &self.identity
    }
    pub fn session(&self) -> &ProfileSessionId {
        &self.session
    }
    pub fn owner(&self) -> &Option<MetadataText> {
        &self.owner
    }
    pub fn generation(&self) -> &EmployeeGeneration {
        &self.generation
    }
}
#[derive(Eq, PartialEq, Ord, PartialOrd)]
enum SessionKey {
    Text(MetadataText),
    Numeric(String),
}
fn session_key(value: &Value) -> Result<Option<SessionKey>> {
    match &value.0 {
        Node::Null => return Ok(None),
        Node::String(value) => {
            return Ok(Some(SessionKey::Text(MetadataText::from_text(
                value.clone(),
            ))));
        }
        _ => {}
    }
    Ok(Some(SessionKey::Numeric(
        legacy_json::numeric_key(&value.0).ok_or(IdentityDataError::AmbiguousRegistry)?,
    )))
}
impl Metadata {
    pub fn company_records(&self) -> Result<CompanyRecords> {
        let company = object(&self.0).ok_or(IdentityDataError::Registry)?;
        let employees = rows(field(company, "employees")).ok_or(IdentityDataError::Registry)?;
        let retired = match field(company, "retired") {
            None => &[][..],
            Some(value) => rows(Some(value)).ok_or(IdentityDataError::Registry)?,
        };
        if employees.len() + retired.len() > 10_000 {
            return Err(IdentityDataError::RegistryBound);
        }
        let mut records = Vec::new();
        let mut ids = BTreeSet::new();
        let mut sessions = BTreeSet::new();
        for row in employees.iter().chain(retired) {
            let row = object(row).ok_or(IdentityDataError::RegistryBound)?;
            let owner = owner(field(row, "owner"))?;
            let identity = text(field(row, "id")).ok_or(IdentityDataError::AmbiguousRegistry)?;
            if !ids.insert(identity.clone()) {
                return Err(IdentityDataError::AmbiguousRegistry);
            }
            if let Some(key) = field(row, "sessionId")
                .map(session_key)
                .transpose()?
                .flatten()
                && !sessions.insert(key)
            {
                return Err(IdentityDataError::AmbiguousRegistry);
            }
            records.push(RegistryEmployee {
                identity,
                session: text(field(row, "sessionId")),
                owner,
            });
        }
        Ok(CompanyRecords { records })
    }
    /// Current-only selection used by GPU projection; OFF/vacation are separate.
    pub fn current_employee(
        &self,
        identity: &ProfileEmployeeId,
        session: &ProfileSessionId,
        owner: &Option<MetadataText>,
    ) -> Result<Option<CurrentEmployee>> {
        let mut matches = self
            .current_rows()?
            .iter()
            .filter_map(object)
            .filter(|row| matches_binding(row, identity, session, owner));
        let Some(row) = matches.next() else {
            return Ok(None);
        };
        if matches.next().is_some() {
            return Err(IdentityDataError::CurrentGeneration);
        }
        let generation = match field(row, "sessionGeneration") {
            Some(Value(Node::Number(Number::Integer(value))))
                if value != "0" && !value.starts_with('-') =>
            {
                EmployeeGeneration(value.clone())
            }
            _ => return Err(IdentityDataError::CurrentGeneration),
        };
        Ok(Some(CurrentEmployee {
            identity: identity.clone(),
            session: session.clone(),
            owner: owner.clone(),
            generation,
        }))
    }
    pub fn current_start_allowed(
        &self,
        identity: &ProfileEmployeeId,
        session: &ProfileSessionId,
        owner: &Option<MetadataText>,
    ) -> Result<bool> {
        let mut selected = Vec::new();
        for row in self.current_rows()? {
            let row = object(row).ok_or(IdentityDataError::CurrentRegistry)?;
            if matches_binding(row, identity, session, owner) {
                selected.push(row);
            }
        }
        Ok(selected.len() == 1
            && !matches!(
                field(selected[0], "desiredRunning"),
                Some(Value(Node::Bool(false)))
            )
            && !truthy(field(selected[0], "onVacation")))
    }
    fn current_rows(&self) -> Result<&[Value]> {
        let company = object(&self.0).ok_or(IdentityDataError::CurrentRegistry)?;
        rows(field(company, "employees")).ok_or(IdentityDataError::CurrentRegistry)
    }
}
fn rows(value: Option<&Value>) -> Option<&[Value]> {
    if let Some(Value(Node::Array(value))) = value {
        Some(value)
    } else {
        None
    }
}
fn matches_binding(
    row: &Object,
    identity: &ProfileEmployeeId,
    session: &ProfileSessionId,
    owner: &Option<MetadataText>,
) -> bool {
    text(field(row, "id")).is_some_and(|value| value.equals_ascii(identity.as_str()))
        && session_matches(field(row, "sessionId"), session)
        && owner_matches(field(row, "owner"), owner)
}
