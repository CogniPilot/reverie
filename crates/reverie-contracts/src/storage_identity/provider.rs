//! Current-company provider observation DATA, never a launch/stop grant.
use super::*;
use crate::broker_reply::BrokerReply;

const FIELDS: [&str; 9] = [
    "id",
    "owner",
    "sessionId",
    "sessionGeneration",
    "desiredRunning",
    "onVacation",
    "bindingMigration",
    "runtimeRecipe",
    "permissions",
];
pub struct ProviderHealthBinding {
    employee: ProfileEmployeeId,
    session: ProfileSessionId,
    generation: u64,
    observed: Value,
    eligible: bool,
}
impl ProviderHealthBinding {
    pub fn employee(&self) -> &ProfileEmployeeId {
        &self.employee
    }
    pub fn session(&self) -> &ProfileSessionId {
        &self.session
    }
    pub fn eligible(&self) -> bool {
        self.eligible
    }
    pub fn unknown_observation(&self, epoch_ms: u64) -> Result<BrokerReply> {
        if epoch_ms > reverie_core::revision::JS_SAFE_MAX {
            return Err(IdentityDataError::CurrentRegistry);
        }
        Ok(BrokerReply::object(vec![
            (
                "observedBinding",
                BrokerReply::observation_data(&self.observed)
                    .ok_or(IdentityDataError::CurrentRegistry)?,
            ),
            ("employeeId", BrokerReply::string(self.employee.as_str())),
            ("sessionId", BrokerReply::string(self.session.as_str())),
            (
                "sessionGeneration",
                BrokerReply::integer(self.generation as i64),
            ),
            ("state", BrokerReply::string("unknown")),
            ("observedAtEpochMs", BrokerReply::integer(epoch_ms as i64)),
            ("reason", BrokerReply::string("UNCONFIRMED")),
        ]))
    }
}
impl Metadata {
    pub fn provider_health_bindings(&self) -> Result<Vec<ProviderHealthBinding>> {
        self.company_records()?; // Includes retired rows in the ambiguity check.
        let company = object(&self.0).ok_or(IdentityDataError::CurrentRegistry)?;
        let Some(Value(Node::Array(rows))) = field(company, "employees") else {
            return Err(IdentityDataError::CurrentRegistry);
        };
        if rows.len() > 64 {
            return Err(IdentityDataError::RegistryBound);
        }
        let mut bindings = Vec::new();
        for value in rows {
            let row = object(value).ok_or(IdentityDataError::CurrentRegistry)?;
            let employee =
                employee_id(&text(field(row, "id")).ok_or(IdentityDataError::CanonicalIdentity)?)?;
            let session = text(field(row, "sessionId"))
                .and_then(|value| value.scalar_text())
                .and_then(|value| ProfileSessionId::parse(&value).ok())
                .ok_or(IdentityDataError::CanonicalIdentity)?;
            owner(field(row, "owner"))?;
            let generation = match field(row, "sessionGeneration") {
                Some(Value(Node::Number(Number::Integer(raw)))) => raw
                    .parse::<u64>()
                    .ok()
                    .filter(|value| *value > 0 && *value <= reverie_core::revision::JS_SAFE_MAX),
                _ => None,
            }
            .ok_or(IdentityDataError::CurrentGeneration)?;
            let observed = Value(Node::Array(
                FIELDS
                    .iter()
                    .map(|name| field(row, name).map_or(Value(Node::Null), Value::deep_clone))
                    .collect(),
            ));
            if !observed.is_finite() {
                return Err(IdentityDataError::CurrentRegistry);
            }
            let eligible = matches!(field(row, "desiredRunning"), Some(Value(Node::Bool(true))))
                && matches!(field(row, "onVacation"), Some(Value(Node::Bool(false))))
                && !truthy(field(row, "bindingMigration"));
            bindings.push(ProviderHealthBinding {
                employee,
                session,
                generation,
                observed,
                eligible,
            });
        }
        bindings.sort_by(|left, right| left.employee.cmp(&right.employee));
        Ok(bindings)
    }
}
