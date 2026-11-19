//! Compatibility-sensitive capacity, cohort and plan data for offline seeding.
use super::{Cohort, QualificationError, Result, Target, digest, require};
use crate::{
    legacy_json::{Node, Text, Value, decode_strict_bytes, numeric_key, truthy},
    storage_identity::Metadata,
    worker_config::compact_data,
};
use reverie_core::ids::{OfflineStoreOperationId, ProfileEmployeeId, ProfileSessionId};
use serde::{Deserialize, Serialize};
use serde_json::value::{RawValue, to_raw_value};
use sha2::{Digest, Sha256};

#[cfg(test)]
mod tests;

fn sha(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapacityBudget {
    full_closure_allocated_bytes: u128,
    overhead_bytes: u128,
    main_floor_bytes: u128,
    scratch_floor_bytes: u128,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capacity {
    gross_model_bytes: u128,
    main_floor_bytes: u128,
    scratch_floor_bytes: u128,
    enforcement: &'static str,
}

impl CapacityBudget {
    pub fn decode(raw: &RawValue) -> Result<Self> {
        serde_json::from_str(raw.get())
            .map_err(|_| QualificationError("finite operator capacity model required"))
    }

    pub fn admit(self, cohort_size: u8, main: u128, scratch: u128) -> Result<Capacity> {
        require(
            cohort_size > 0
                && self.full_closure_allocated_bytes > 0
                && self.overhead_bytes > 0
                && self.main_floor_bytes > 0
                && self.scratch_floor_bytes > 0,
            "finite operator capacity model required",
        )?;
        let unavailable = QualificationError("capacity model/floor unavailable");
        let charge = self
            .full_closure_allocated_bytes
            .checked_mul(3 * u128::from(cohort_size))
            .and_then(|copies| copies.checked_add(self.overhead_bytes))
            .ok_or(unavailable)?;
        if main
            .checked_sub(charge)
            .is_none_or(|left| left < self.main_floor_bytes)
            || scratch < self.scratch_floor_bytes
        {
            return Err(unavailable);
        }
        Ok(Capacity {
            gross_model_bytes: charge,
            main_floor_bytes: self.main_floor_bytes,
            scratch_floor_bytes: self.scratch_floor_bytes,
            enforcement: "MODEL_NOT_QUOTA_NO_GC_OR_DEDUP_CREDIT",
        })
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CohortBinding<'a> {
    session_id: &'a str,
    employee_digest: &'a str,
}

impl CohortBinding<'_> {
    pub fn session(&self) -> &str {
        self.session_id
    }
    pub fn digest(&self) -> &str {
        self.employee_digest
    }
}

/// Preserve escaped Unix path bytes in planned helper arguments.
pub fn plan_text(value: &crate::storage_identity::MetadataText) -> Box<RawValue> {
    let ascii = compact_data(&Value(Node::String(Text(value.codepoints().to_vec()))));
    RawValue::from_string(String::from_utf8(ascii).expect("ASCII plan text"))
        .expect("encoded plan text")
}

impl Target {
    /// Verify all members, including when only one employee is being prepared.
    /// A recheck compares complete employee digests. Initial selection also
    /// checks the explicit offline intent, session binding and generation.
    pub fn admit_cohort<'a>(
        &'a self,
        company: &Metadata,
        employee: Option<&ProfileEmployeeId>,
    ) -> Result<Option<CohortBinding<'a>>> {
        let Some(Node::Array(employees)) = field(company.as_value(), "employees").map(|v| &v.0)
        else {
            return Err(QualificationError("current employee binding unavailable"));
        };
        let mut selected = None;
        for binding in &self.cohort {
            let row = current_row(employees, &binding.employee_id)?;
            require(
                (employee.is_none() || binding.is_offline(row))
                    && sha(&compact_data(row)) == binding.employee_digest,
                "offline employee/cohort changed",
            )?;
            if employee.is_some_and(|id| id.as_str() == binding.employee_id) {
                selected = Some(CohortBinding {
                    session_id: &binding.session_id,
                    employee_digest: &binding.employee_digest,
                });
            }
        }
        require(
            employee.is_none() || selected.is_some(),
            "employee is outside the admitted offline cohort",
        )?;
        Ok(selected)
    }
}

impl Cohort {
    fn is_offline(&self, row: &Value) -> bool {
        text_equal(field(row, "sessionId"), &self.session_id)
            && field(row, "sessionGeneration")
                .and_then(|value| numeric_key(&value.0))
                .is_some_and(|generation| generation == self.session_generation.to_string())
            && matches!(field(row, "desiredRunning"), Some(Value(Node::Bool(false))))
            && matches!(field(row, "onVacation"), Some(Value(Node::Bool(true))))
            && !truthy(field(row, "bindingMigration"))
    }
}

fn field<'a>(object: &'a Value, key: &str) -> Option<&'a Value> {
    let Node::Object(fields) = &object.0 else {
        return None;
    };
    fields.get(&Text(key.bytes().map(u32::from).collect()))
}

fn text_equal(value: Option<&Value>, text: &str) -> bool {
    matches!(value, Some(Value(Node::String(value))) if value.equals_ascii(text))
}

fn current_row<'a>(employees: &'a [Value], id: &str) -> Result<&'a Value> {
    let mut matches = employees
        .iter()
        .filter(|row| text_equal(field(row, "id"), id));
    let unavailable = QualificationError("current employee binding unavailable");
    let employee = matches.next().ok_or(unavailable)?;
    require(matches.next().is_none(), unavailable.0)?;
    Ok(employee)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanFacts<'a> {
    pub config_digest: &'a str,
    pub target_digest: &'a str,
    pub employee_digest: &'a str,
    pub home_identity: [u64; 4],
    pub nix_identity: [u64; 4],
    pub lock_identity: [u64; 4],
    pub sid_lock_identity: [u64; 4],
    pub profiles: Box<RawValue>,
    pub budget: Capacity,
    pub stopped_container_ids: Vec<String>,
    pub helper_args: Vec<Box<RawValue>>,
    pub helper_name: Box<RawValue>,
}

impl PlanFacts<'_> {
    pub fn encode(&self) -> Result<Box<RawValue>> {
        to_raw_value(self).map_err(|_| QualificationError("offline plan facts unavailable"))
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Plan<'a> {
    version: u8,
    kind: &'static str,
    operation_id: &'a str,
    employee_id: &'a str,
    session_id: &'a str,
    image_id: &'a str,
    facts: &'a RawValue,
}

/// Seal the observation using the installed plan schema and legacy digest.
/// Observations and digests are data, and do not authorize a seed operation.
pub fn plan(
    operation: &str,
    employee: &str,
    session: &str,
    image: &str,
    facts: &RawValue,
) -> Result<Vec<u8>> {
    require(
        ProfileEmployeeId::parse(employee).is_ok()
            && OfflineStoreOperationId::parse(operation).is_ok(),
        "exact operation/employee UUID required",
    )?;
    require(
        ProfileSessionId::parse(session).is_ok() && digest(image),
        "exact plan session/image required",
    )?;
    let invalid = QualificationError("offline plan facts unavailable");
    let body = serde_json::to_vec(&Plan {
        version: 1,
        kind: "reverie.offline-store.plan",
        operation_id: operation,
        employee_id: employee,
        session_id: session,
        image_id: image,
        facts,
    })
    .map_err(|_| invalid)?;
    let mut body = decode_strict_bytes(&body).map_err(|_| invalid)?;
    let digest = sha(&compact_data(&body));
    let Node::Object(fields) = &mut body.0 else {
        return Err(invalid);
    };
    fields.insert(
        Text("planDigest".bytes().map(u32::from).collect()),
        Value(Node::String(Text(digest.bytes().map(u32::from).collect()))),
    );
    Ok(compact_data(&body))
}
