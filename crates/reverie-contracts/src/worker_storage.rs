//! Storage publication and related-lineage DATA. No filesystem/lease authority.
mod instructions;
use crate::legacy_json::{Node, Number, Text, Value, truthy};
use crate::storage_identity::{IdentityDataError, Metadata, MetadataText};
use crate::worker_config::encode_data;
pub use instructions::{InstructionDataError, storage_instruction_bytes};
use reverie_core::ids::{ProfileEmployeeId, ProfileSessionId};
use std::collections::{BTreeMap, BTreeSet};

/// Captured configuration DATA. Resource maps and mounts are not eagerly
/// validated by storage operations; each original phase reads its own fields.
pub struct StorageConfiguration(crate::worker_config::EffectiveWorkerConfig);
impl StorageConfiguration {
    pub fn storage_path_text(
        &self,
        identity: crate::reservation_engine::StorageIdentityRef<'_>,
    ) -> std::result::Result<
        crate::reservation_engine::StoragePathText,
        crate::reservation_engine::EngineDataError,
    > {
        crate::reservation_engine::ReservationConfiguration::capture(self.0.clone())
            .storage_text(identity)
    }
    pub fn has_shared_workspace(&self) -> Result<bool> {
        let root = object(self.0.as_value()).expect("worker object invariant");
        let Some(Value(Node::Array(rows))) = root.get(&key("mounts")) else {
            return Err(IdentityDataError::Registry);
        };
        for row in rows {
            let Some(row) = object(row) else {
                return Err(IdentityDataError::Registry);
            };
            let destination = row
                .get(&key("destination"))
                .ok_or(IdentityDataError::Registry)?;
            if matches!(destination,Value(Node::String(text)) if text.equals_ascii("/reverie_workspace"))
            {
                return Ok(true);
            }
        }
        Ok(false)
    }
    pub fn capture(source: &crate::worker_config::EffectiveWorkerConfig) -> Self {
        Self(source.clone())
    }
    pub fn identity_settings(
        &self,
    ) -> std::result::Result<
        crate::resource_config::ResourceIdentitySettings,
        crate::broker_resources::ResourceConfigError,
    > {
        crate::resource_config::ResourceIdentitySettings::capture_worker_config(&self.0)
    }
    pub fn shared_sources(&self) -> Result<impl Iterator<Item = Result<MetadataText>> + '_> {
        let root = object(self.0.as_value()).expect("worker object invariant");
        let rows = match root.get(&key("mounts")) {
            None => &[][..],
            Some(Value(Node::Array(rows))) => rows.as_slice(),
            _ => return Err(IdentityDataError::Registry),
        };
        Ok(rows.iter().map(|row| {
            let Some(Value(Node::String(value))) = object(row).and_then(|v| v.get(&key("source")))
            else {
                return Err(IdentityDataError::Registry);
            };
            Ok(MetadataText::from_text(value.clone()))
        }))
    }
}

type Result<T> = std::result::Result<T, IdentityDataError>;
fn key(value: &str) -> Text {
    Text(value.chars().map(u32::from).collect())
}
fn text(value: &str) -> Value {
    Value(Node::String(key(value)))
}
fn expected(fields: &[(&str, Value)]) -> Value {
    Value(Node::Object(
        fields
            .iter()
            .map(|(k, v)| (key(k), v.deep_clone()))
            .collect(),
    ))
}
fn ready(employee: &ProfileEmployeeId) -> Value {
    expected(&[
        ("version", Value(Node::Number(Number::Integer("1".into())))),
        ("kind", text("employee")),
        ("identity", text(employee.as_str())),
        ("state", text("ready")),
    ])
}
fn binding(
    employee: &ProfileEmployeeId,
    session: &ProfileSessionId,
    owner: &Option<MetadataText>,
) -> Value {
    expected(&[
        ("version", Value(Node::Number(Number::Integer("1".into())))),
        ("employeeId", text(employee.as_str())),
        ("sessionId", text(session.as_str())),
        (
            "owner",
            owner.as_ref().map_or(Value(Node::Null), |v| {
                Value(Node::String(Text(v.codepoints().to_vec())))
            }),
        ),
    ])
}
pub fn ready_storage_bytes(employee: &ProfileEmployeeId) -> Vec<u8> {
    encode_data(&ready(employee))
}
pub fn storage_binding_bytes(
    employee: &ProfileEmployeeId,
    session: &ProfileSessionId,
    owner: &Option<MetadataText>,
) -> Vec<u8> {
    encode_data(&binding(employee, session, owner))
}
impl Metadata {
    pub fn matches_ready_storage(&self, employee: &ProfileEmployeeId) -> bool {
        self.as_value().python_eq(&ready(employee))
    }
    pub fn matches_storage_binding(
        &self,
        employee: &ProfileEmployeeId,
        session: &ProfileSessionId,
        owner: &Option<MetadataText>,
    ) -> bool {
        self.as_value()
            .python_eq(&binding(employee, session, owner))
    }
    /// Current rows only, short-circuiting at the first match. OFF is allowed;
    /// retired rows, generations and execution eligibility are not consulted.
    pub fn has_current_storage_binding(
        &self,
        employee: &ProfileEmployeeId,
        session: &ProfileSessionId,
        owner: &Option<MetadataText>,
    ) -> Result<bool> {
        let Some(Value(Node::Array(rows))) =
            object(self.as_value()).and_then(|v| v.get(&key("employees")))
        else {
            return Err(IdentityDataError::CurrentRegistry);
        };
        for row in rows {
            let row = object(row).ok_or(IdentityDataError::CurrentRegistry)?;
            if equal(row.get(&key("id")), &text(employee.as_str()))
                && equal(row.get(&key("sessionId")), &text(session.as_str()))
                && owner_equal(row, owner)
            {
                return Ok(true);
            }
        }
        Ok(false)
    }
    /// Related employee+owner edges alone validate their phase/endpoints. All
    /// entries must still be objects, and the original 100-entry bound applies.
    pub fn storage_migration_sessions(
        &self,
        employee: &ProfileEmployeeId,
        owner: &Option<MetadataText>,
    ) -> Result<BTreeSet<ProfileSessionId>> {
        let Node::Array(rows) = &self.as_value().0 else {
            return Err(IdentityDataError::PlanJournal);
        };
        if rows.len() > 100 {
            return Err(IdentityDataError::PlanJournal);
        }
        let mut result = BTreeSet::new();
        for row in rows {
            let row = object(row).ok_or(IdentityDataError::PlanJournal)?;
            if !equal(row.get(&key("employeeId")), &text(employee.as_str()))
                || !owner_equal(row, owner)
            {
                continue;
            }
            crate::storage_identity::lineage::validate_phase(row.get(&key("phase")))?;
            for name in ["oldSession", "newSession"] {
                add_session(&mut result, row.get(&key(name)))?;
            }
        }
        Ok(result)
    }
}
fn add_session(result: &mut BTreeSet<ProfileSessionId>, value: Option<&Value>) -> Result<()> {
    if !truthy(value) {
        return Ok(());
    }
    let Some(Value(Node::String(value))) = value else {
        return Err(IdentityDataError::CanonicalIdentity);
    };
    let value: String = value
        .0
        .iter()
        .map(|&cp| char::from_u32(cp))
        .collect::<Option<_>>()
        .ok_or(IdentityDataError::CanonicalIdentity)?;
    result
        .insert(ProfileSessionId::parse(&value).map_err(|_| IdentityDataError::CanonicalIdentity)?);
    Ok(())
}
fn object(value: &Value) -> Option<&BTreeMap<Text, Value>> {
    if let Node::Object(value) = &value.0 {
        Some(value)
    } else {
        None
    }
}
fn equal(value: Option<&Value>, expected: &Value) -> bool {
    value.is_some_and(|v| v.python_eq(expected))
}
fn owner_equal(row: &BTreeMap<Text, Value>, owner: &Option<MetadataText>) -> bool {
    let expected = owner.as_ref().map_or(Value(Node::Null), |v| {
        Value(Node::String(Text(v.codepoints().to_vec())))
    });
    row.get(&key("owner"))
        .unwrap_or(&Value(Node::Null))
        .python_eq(&expected)
}
