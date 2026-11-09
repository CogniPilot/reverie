//! Privacy-bounded preservation observations; no launch or owner capability.
use super::*;
use crate::broker_reply::BrokerReply;
use sha2::{Digest, Sha256};

fn digest(value: &Value) -> Result<String> {
    let bytes = BrokerReply::observation_data(value)
        .ok_or(IdentityDataError::CurrentRegistry)?
        .encode();
    Ok(crate::digest::hex(&Sha256::digest(bytes).into()))
}
fn fingerprint(value: Option<&Value>) -> Result<BrokerReply> {
    value.map_or(Ok(BrokerReply::null()), |value| {
        Ok(BrokerReply::string(&digest(value)?))
    })
}
fn intent(
    row: &Object,
    name: &'static str,
    output: &mut Vec<(&'static str, BrokerReply)>,
) -> Result<()> {
    if let Some(value) = field(row, name) {
        let value = match value.0 {
            Node::Null => BrokerReply::null(),
            Node::Bool(value) => BrokerReply::boolean(value),
            _ => return Err(IdentityDataError::CurrentRegistry),
        };
        output.push((name, value));
    }
    Ok(())
}
fn generation(row: &Object, output: &mut Vec<(&'static str, BrokerReply)>) -> Result<()> {
    if let Some(value) = field(row, "sessionGeneration") {
        output.push((
            "sessionGeneration",
            match &value.0 {
                Node::Null => BrokerReply::null(),
                Node::Number(Number::Integer(raw)) if raw != "0" && !raw.starts_with('-') => {
                    BrokerReply::string(raw)
                }
                Node::Number(Number::Float(raw))
                    if raw.is_finite() && *raw > 0.0 && raw.fract() == 0.0 =>
                {
                    BrokerReply::string(&format!("{raw:.0}"))
                }
                _ => return Err(IdentityDataError::CurrentGeneration),
            },
        ));
    }
    Ok(())
}
fn employee(value: &Value, retired: bool, sessions: Option<&Object>) -> Result<BrokerReply> {
    let row = object(value).ok_or(IdentityDataError::Registry)?;
    let id = field(row, "id")
        .filter(|v| matches!(v.0, Node::String(_)))
        .ok_or(IdentityDataError::Registry)?;
    let sid = match field(row, "sessionId") {
        None | Some(Value(Node::Null)) => None,
        Some(value @ Value(Node::String(_))) => Some(value),
        _ => return Err(IdentityDataError::Registry),
    };
    let saved = sid.as_ref().and_then(|sid| match &sid.0 {
        Node::String(sid) => sessions.and_then(|s| s.get(sid)),
        _ => None,
    });
    let mut output = vec![
        (
            "employeeId",
            BrokerReply::observation_data(id).ok_or(IdentityDataError::Registry)?,
        ),
        (
            "sessionId",
            sid.map_or(Ok(BrokerReply::null()), |s| {
                BrokerReply::observation_data(s).ok_or(IdentityDataError::Registry)
            })?,
        ),
        ("retired", BrokerReply::boolean(retired)),
        ("recordDigest", BrokerReply::string(&digest(value)?)),
        ("ownerDigest", fingerprint(field(row, "owner"))?),
        (
            "runtimeRecipeDigest",
            fingerprint(field(row, "runtimeRecipe"))?,
        ),
        ("savedSessionDigest", fingerprint(saved)?),
    ];
    intent(row, "desiredRunning", &mut output)?;
    intent(row, "onVacation", &mut output)?;
    generation(row, &mut output)?;
    Ok(BrokerReply::object(output))
}
impl Metadata {
    /// Exact existing documents are observed, never normalized or rewritten.
    /// Digests use the finite lossless metadata encoding, not a backup format.
    /// Saved-session digests cover whole records, including volatile fields.
    pub fn owner_inventory(
        &self,
        state: Option<&Metadata>,
        plans: Option<&Metadata>,
    ) -> Result<BrokerReply> {
        self.company_records()?;
        let company = object(&self.0).ok_or(IdentityDataError::Registry)?;
        let sessions = state
            .map(|state| {
                let root = object(&state.0).ok_or(IdentityDataError::Registry)?;
                object(field(root, "sessions").ok_or(IdentityDataError::Registry)?)
                    .ok_or(IdentityDataError::Registry)
            })
            .transpose()?;
        if let Some(plans) = plans {
            let encoded = BrokerReply::observation_data(&plans.0)
                .ok_or(IdentityDataError::PlanJournal)?
                .encode();
            crate::subscription_profiles_v1::parse_file(
                &encoded,
                crate::subscription_profiles_v1::Platform::Posix,
            )
            .map_err(|_| IdentityDataError::PlanJournal)?;
        }
        let mut employees = Vec::new();
        for (name, retired) in [("employees", false), ("retired", true)] {
            let selected = match field(company, name) {
                None if retired => &[][..],
                Some(Value(Node::Array(rows))) => rows.as_slice(),
                _ => return Err(IdentityDataError::Registry),
            };
            for row in selected {
                employees.push(employee(row, retired, sessions)?);
            }
        }
        Ok(BrokerReply::object(vec![
            ("version", BrokerReply::integer(1)),
            ("purpose", BrokerReply::string("worker-owner-inventory-v1")),
            ("readOnly", BrokerReply::boolean(true)),
            ("backup", BrokerReply::boolean(false)),
            ("atomicSnapshot", BrokerReply::boolean(false)),
            ("companyDigest", BrokerReply::string(&digest(&self.0)?)),
            ("state", fingerprint(state.map(|v| &v.0))?),
            ("declaredPlans", fingerprint(plans.map(|v| &v.0))?),
            ("employees", BrokerReply::array(employees)),
        ]))
    }
}
