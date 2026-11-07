use super::*;
/// The selected original current employee row, retaining unrelated fields and
/// codepoints for exact later comparison/hashes. Not execution eligibility.
pub struct ReservationEmployee {
    value: Value,
    employee: ProfileEmployeeId,
    session: ProfileSessionId,
}
/// One freshly read EID row retained for terminal claim comparison/hash. Its
/// unrelated fields and SID remain data; no generation/start gate is added.
pub struct ClaimEmployee {
    value: Value,
    employee: ProfileEmployeeId,
}
impl ClaimEmployee {
    /// Named pre-approval profile-selection fields. Missing/wrong SID uses
    /// J's canonical role refusal, distinct from observe()'s indexed SID read.
    pub fn selection_session(&self) -> reverie_core::operations::Result<ProfileSessionId> {
        let invalid = || reverie_core::operations::OperationError::new("UUID");
        let row = object(&self.value).map_err(|_| invalid())?;
        let Some(Value(Node::String(value))) = row.get(&key("sessionId")) else {
            return Err(invalid());
        };
        let text = value
            .0
            .iter()
            .map(|&p| char::from_u32(p))
            .collect::<Option<String>>()
            .ok_or_else(invalid)?;
        let value = reverie_core::operations::JournalId::parse(&text)?;
        Ok(ProfileSessionId::parse(value.as_str()).expect("checked canonical role"))
    }
    pub fn selection_generation(&self) -> reverie_core::operations::Result<Generation> {
        let invalid = || reverie_core::operations::OperationError::new("VERSION");
        let row = object(&self.value).map_err(|_| invalid())?;
        let Some(Value(Node::Number(Number::Integer(value)))) = row.get(&key("sessionGeneration"))
        else {
            return Err(invalid());
        };
        Generation::try_new(value.parse::<u64>().map_err(|_| invalid())?).map_err(|_| invalid())
    }
    pub fn selection_intent(
        &self,
        scope: &reverie_core::operations::OperationScope,
    ) -> Result<bool> {
        let row = object(&self.value)?;
        if !matches!(
            row.get(&key("desiredRunning")),
            Some(Value(Node::Bool(true)))
        ) || crate::legacy_json::truthy(row.get(&key("onVacation")))
            || crate::legacy_json::truthy(row.get(&key("bindingMigration")))
        {
            return Ok(false);
        }
        Ok(owner_digest(&self.value, &scope.company_id)? == scope.owner_scope_digest)
    }
    pub fn capture(metadata: &Metadata, employee: &ProfileEmployeeId) -> Result<Self> {
        let selected = eid_rows(metadata, employee)?;
        if selected.len() != 1 {
            return Err(ObservationDataError::CurrentEmployee);
        }
        Ok(Self {
            value: selected[0].deep_clone(),
            employee: employee.clone(),
        })
    }
    pub fn still_current(&self, metadata: &Metadata) -> Result<bool> {
        unchanged(metadata, &self.employee, &self.value)
    }
    pub(crate) fn data(&self) -> &Value {
        &self.value
    }
    /// Named publication projection DATA, not a registry write or scope grant.
    pub(crate) fn projected(&self, value: Value) -> Self {
        Self {
            value,
            employee: self.employee.clone(),
        }
    }
}
impl ReservationEmployee {
    /// The first matching EID's raw SID, before storage_paths' separate full
    /// registry/lineage selection. Unrelated rows are deliberately not given
    /// UUID/generation/owner requirements at this first selection phase.
    /// Like next(generator, ''), iteration stops at the first matching EID;
    /// only that selected row's indexed sessionId is a required field here.
    pub fn first_session(
        metadata: &Metadata,
        employee: &ProfileEmployeeId,
    ) -> Result<Option<crate::storage_identity::MetadataText>> {
        for row in employees(metadata)? {
            let row = object(row)?;
            if matches_text(row.get(&key("id")), employee.as_str()) {
                let session = row
                    .get(&key("sessionId"))
                    .ok_or(ObservationDataError::CompanyStructure)?;
                return Ok(match session {
                    Value(Node::String(text)) => Some(
                        crate::storage_identity::MetadataText::from_text(text.clone()),
                    ),
                    _ => None,
                });
            }
        }
        Ok(None)
    }
    pub fn select(
        metadata: &Metadata,
        employee: &ProfileEmployeeId,
        session: &ProfileSessionId,
    ) -> Result<Self> {
        let mut found = None;
        for value in employees(metadata)? {
            let row = object(value)?;
            if !matches_text(row.get(&key("id")), employee.as_str())
                || !matches_text(row.get(&key("sessionId")), session.as_str())
            {
                continue;
            }
            if found.is_some() {
                return Err(ObservationDataError::CurrentEmployee);
            }
            found = Some(value);
        }
        Ok(Self {
            value: found
                .ok_or(ObservationDataError::CurrentEmployee)?
                .deep_clone(),
            employee: employee.clone(),
            session: session.clone(),
        })
    }
    pub fn identity(&self) -> &ProfileEmployeeId {
        &self.employee
    }
    pub fn session(&self) -> &ProfileSessionId {
        &self.session
    }
    pub fn owner_scope_digest(
        &self,
        company: &reverie_core::operations::JournalId,
    ) -> Result<reverie_core::operations::JournalDigest> {
        owner_digest(&self.value, company)
    }
    pub(super) fn data(&self) -> &Value {
        &self.value
    }
    /// This check belongs after the owner-scope fingerprint check, not at the
    /// initial company or storage selection phase.
    pub fn generation(&self) -> Result<Generation> {
        let row = object(&self.value)?;
        let Some(Value(Node::Number(Number::Integer(value)))) = row.get(&key("sessionGeneration"))
        else {
            return Err(ObservationDataError::Generation);
        };
        let number = value
            .parse::<u64>()
            .map_err(|_| ObservationDataError::Generation)?;
        if number == 0 {
            return Err(ObservationDataError::Generation);
        }
        Generation::try_new(number).map_err(|_| ObservationDataError::Generation)
    }
    /// Later old observe() compares every current row with the EID, independent
    /// of SID, against this one exact original row. No global registry rewrite.
    pub fn still_current(&self, metadata: &Metadata) -> Result<bool> {
        unchanged(metadata, &self.employee, &self.value)
    }
}
fn owner_digest(
    value: &Value,
    company: &reverie_core::operations::JournalId,
) -> Result<reverie_core::operations::JournalDigest> {
    let row = object(value)?;
    let fields = [
        (
            key("company_id"),
            Value(Node::String(key(company.as_str()))),
        ),
        (
            key("owner"),
            row.get(&key("owner"))
                .map_or_else(|| Value(Node::Null), Value::deep_clone),
        ),
    ]
    .into_iter()
    .collect();
    super::digests::digest(&Value(Node::Object(fields)))
}
fn eid_rows<'a>(metadata: &'a Metadata, employee: &ProfileEmployeeId) -> Result<Vec<&'a Value>> {
    let mut selected = Vec::new();
    for value in employees(metadata)? {
        if matches_text(object(value)?.get(&key("id")), employee.as_str()) {
            selected.push(value);
        }
    }
    Ok(selected)
}
fn unchanged(metadata: &Metadata, employee: &ProfileEmployeeId, value: &Value) -> Result<bool> {
    let selected = eid_rows(metadata, employee)?;
    Ok(selected.len() == 1 && selected[0].python_eq(value))
}
