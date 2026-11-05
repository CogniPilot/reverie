use super::*;
use std::collections::BTreeSet;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StoredBinding {
    employee: ProfileEmployeeId,
    owner: Option<MetadataText>,
}
impl StoredBinding {
    pub fn employee(&self) -> &ProfileEmployeeId {
        &self.employee
    }
    pub fn owner(&self) -> &Option<MetadataText> {
        &self.owner
    }
}
impl Metadata {
    pub fn storage_owner(&self, session: &ProfileSessionId) -> Result<StoredBinding> {
        let value = object(&self.0).ok_or(IdentityDataError::StoredBinding)?;
        if value.len() != 4
            || !["version", "employeeId", "sessionId", "owner"]
                .iter()
                .all(|key| field(value, key).is_some())
            || !is_one(field(value, "version"))
            || !session_matches(field(value, "sessionId"), session)
        {
            return Err(IdentityDataError::StoredBinding);
        }
        let employee = employee_id(
            &text(field(value, "employeeId")).ok_or(IdentityDataError::CanonicalIdentity)?,
        )?;
        Ok(StoredBinding {
            employee,
            owner: owner(field(value, "owner"))?,
        })
    }
    /// Only related edges have their phase/employee fields checked, as in the
    /// legacy journal fallback. Unrelated plan records are never rewritten.
    pub fn historical_employee(
        &self,
        records: &CompanyRecords,
        session: &ProfileSessionId,
    ) -> Result<Option<RegistryEmployee>> {
        let Node::Array(moves) = &self.0.0 else {
            return Err(IdentityDataError::PlanJournal);
        };
        if moves.len() > 100 {
            return Err(IdentityDataError::PlanJournal);
        }
        let mut selected = BTreeSet::new();
        for move_value in moves {
            let row = object(move_value).ok_or(IdentityDataError::PlanJournal)?;
            if !session_matches(field(row, "oldSession"), session)
                && !session_matches(field(row, "newSession"), session)
            {
                continue;
            }
            let phase = text(field(row, "phase")).ok_or(IdentityDataError::PlanPhase)?;
            if ![
                "waiting",
                "creating",
                "starting",
                "checking",
                "stopping",
                "completed",
                "failed",
                "recovery-required",
                "quiescing",
            ]
            .iter()
            .any(|value| phase.equals_ascii(value))
            {
                return Err(IdentityDataError::PlanPhase);
            }
            let candidate = records
                .records()
                .iter()
                .find(|record| {
                    text(field(row, "employeeId")).as_ref() == Some(record.identity())
                        && owner_matches(field(row, "owner"), record.owner())
                })
                .ok_or(IdentityDataError::PlanEmployee)?;
            selected.insert(candidate.identity().clone());
        }
        if selected.len() > 1 {
            return Err(IdentityDataError::AmbiguousPlanIdentity);
        }
        Ok(records
            .records()
            .iter()
            .find(|row| selected.contains(row.identity()))
            .cloned())
    }
}
