use super::*;
/// The selected original current employee row, retaining unrelated fields and
/// codepoints for exact later comparison/hashes. Not execution eligibility.
pub struct ReservationEmployee {
    value: Value,
    employee: ProfileEmployeeId,
    session: ProfileSessionId,
}
impl ReservationEmployee {
    /// The first matching EID's raw SID, before storage_paths' separate full
    /// registry/lineage selection. Unrelated rows are deliberately not given
    /// UUID/generation/owner requirements at this first selection phase.
    pub fn first_session(
        metadata: &Metadata,
        employee: &ProfileEmployeeId,
    ) -> Result<Option<crate::storage_identity::MetadataText>> {
        for row in employees(metadata)? {
            let row = object(row)?;
            if matches_text(row.get(&key("id")), employee.as_str()) {
                return Ok(match row.get(&key("sessionId")) {
                    Some(Value(Node::String(text))) => Some(
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
        let row = object(&self.value)?;
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
        let mut selected = Vec::new();
        for value in employees(metadata)? {
            if matches_text(object(value)?.get(&key("id")), self.employee.as_str()) {
                selected.push(value);
            }
        }
        Ok(selected.len() == 1 && selected[0].python_eq(&self.value))
    }
}
