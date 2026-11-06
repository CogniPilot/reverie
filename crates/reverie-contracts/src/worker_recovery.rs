//! Actual Broker recovery/inspect DATA shapes, not CID ownership or grants.
use crate::{
    kernel_accounting,
    legacy_json::{self, Node, Text, Value},
    worker_config::WorkerPolicyDigest,
};
use reverie_core::{
    ids::ProfileSessionId, worker_laptop::WorkerContainerName, worker_schema::WorkerBase,
};
use std::{
    collections::{BTreeMap, BTreeSet},
    fmt,
};
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RecoveryDataError {
    DuplicateNames,
    InspectionUnavailable,
    MemoryTarget,
    OfficeAddress,
}
impl RecoveryDataError {
    pub fn code(self) -> &'static str {
        match self {
            Self::DuplicateNames => "WORKER_RECOVERY_DUPLICATE_INVENTORY",
            Self::InspectionUnavailable => "WORKER_CONTAINER_STATE_UNAVAILABLE",
            Self::MemoryTarget => "WORKER_RECOVERY_MEMORY_TARGET_CHANGED",
            Self::OfficeAddress => "OFFICE_API_UNAVAILABLE",
        }
    }
}
impl fmt::Display for RecoveryDataError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.code())
    }
}
impl std::error::Error for RecoveryDataError {}
type Result<T> = std::result::Result<T, RecoveryDataError>;
pub struct RecoveryNames(Vec<(ProfileSessionId, WorkerContainerName)>);
impl RecoveryNames {
    pub fn decode(base: &WorkerBase, stdout: &str) -> Result<Self> {
        let lines = crate::reservation_engine::splitlines(stdout);
        if lines.iter().collect::<BTreeSet<_>>().len() != lines.len() {
            return Err(RecoveryDataError::DuplicateNames);
        }
        let mut selected: Vec<(ProfileSessionId, WorkerContainerName)> = Vec::new();
        for line in lines {
            let Some((session, name)) = WorkerContainerName::from_recovered_name_data(base, line)
            else {
                continue;
            };
            if let Some(entry) = selected.iter_mut().find(|(sid, _)| *sid == session) {
                entry.1 = name;
            } else {
                selected.push((session, name));
            }
        }
        Ok(Self(selected))
    }
    pub fn entries(&self) -> &[(ProfileSessionId, WorkerContainerName)] {
        &self.0
    }
}
pub enum RecoveryInspectionNeed {
    Present(RecoveryInspection),
    ConfirmAbsence,
}
pub struct RecoveryInspection {
    value: Value,
    running: bool,
}
#[derive(Clone)]
pub struct OfficeAddressData(crate::storage_identity::MetadataText);
impl OfficeAddressData {
    pub fn codepoints(&self) -> &[u32] {
        self.0.codepoints()
    }
    pub fn scalar_text(&self) -> Option<String> {
        self.0.scalar_text()
    }
}
fn key(name: &str) -> Text {
    Text(name.chars().map(u32::from).collect())
}
fn field<'a>(value: &'a Value, name: &str) -> Result<Option<&'a Value>> {
    let Node::Object(fields) = &value.0 else {
        return Err(RecoveryDataError::InspectionUnavailable);
    };
    Ok(fields.get(&key(name)))
}
impl RecoveryInspection {
    /// ipaddress.ip_address validates the original literal before Python's
    /// later socket IDNA encoding. Preserve scope text/codepoints as DATA.
    pub fn office_address_data(&self) -> Result<OfficeAddressData> {
        if !self.running {
            return Err(RecoveryDataError::OfficeAddress);
        }
        let mut value = &self.value;
        for name in ["NetworkSettings", "Networks", "bridge", "IPAddress"] {
            value = field(value, name)
                .map_err(|_| RecoveryDataError::OfficeAddress)?
                .ok_or(RecoveryDataError::OfficeAddress)?;
        }
        let Value(Node::String(literal)) = value else {
            return Err(RecoveryDataError::OfficeAddress);
        };
        let separator = literal.0.iter().position(|cp| *cp == 37);
        let base = separator.map_or(literal.0.as_slice(), |at| &literal.0[..at]);
        let ascii = base
            .iter()
            .copied()
            .map(char::from_u32)
            .collect::<Option<String>>()
            .ok_or(RecoveryDataError::OfficeAddress)?;
        let parsed = ascii
            .parse::<std::net::IpAddr>()
            .map_err(|_| RecoveryDataError::OfficeAddress)?;
        if let Some(at) = separator {
            let scope = &literal.0[at + 1..];
            if !parsed.is_ipv6() || scope.is_empty() || scope.contains(&37) {
                return Err(RecoveryDataError::OfficeAddress);
            }
        }
        Ok(OfficeAddressData(
            crate::storage_identity::MetadataText::from_text(literal.clone()),
        ))
    }
    /// Only the two real missing-object exit codes may reach a second native
    /// complete-name inventory. A diagnostic string alone is never absence.
    pub fn inspect_data(
        name: &str,
        stdout: &str,
        stderr: &str,
        code: u8,
    ) -> Result<RecoveryInspectionNeed> {
        if code != 0 {
            let missing = [
                format!("Error: No such object: {name}"),
                format!("Error: no such object: \"{name}\""),
                format!("Error: inspecting object: no such object: \"{name}\""),
            ];
            if matches!(code, 1 | 125)
                && matches!(kernel_accounting::strip(stdout), "" | "[]")
                && missing
                    .iter()
                    .any(|value| value == kernel_accounting::strip(stderr))
            {
                return Ok(RecoveryInspectionNeed::ConfirmAbsence);
            }
            return Err(RecoveryDataError::InspectionUnavailable);
        }
        let mut raw = legacy_json::decode_python_str(stdout.as_bytes())
            .map_err(|_| RecoveryDataError::InspectionUnavailable)?;
        let Node::Array(rows) = &mut raw.0 else {
            return Err(RecoveryDataError::InspectionUnavailable);
        };
        if rows.len() != 1 {
            return Err(RecoveryDataError::InspectionUnavailable);
        }
        let value = std::mem::replace(&mut rows[0], Value(Node::Null));
        let state = field(&value, "State")?.ok_or(RecoveryDataError::InspectionUnavailable)?;
        let Some(Value(Node::Bool(running))) = field(state, "Running")? else {
            return Err(RecoveryDataError::InspectionUnavailable);
        };
        let running = *running;
        Ok(RecoveryInspectionNeed::Present(Self { value, running }))
    }
    pub fn confirmed_absence_data(name: &str, stdout: &str) -> Result<Self> {
        let names = crate::reservation_engine::splitlines(stdout);
        let valid = |name: &&str| {
            let raw = name.as_bytes();
            !raw.is_empty()
                && raw[0].is_ascii_alphanumeric()
                && raw
                    .iter()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-'))
        };
        if names.iter().collect::<BTreeSet<_>>().len() != names.len()
            || !names.iter().all(valid)
            || names.contains(&name)
        {
            return Err(RecoveryDataError::InspectionUnavailable);
        }
        let value = legacy_json::decode_python_str(br#"{"State":{"Running":false}}"#)
            .expect("fixed absent state DATA");
        Ok(Self {
            value,
            running: false,
        })
    }
    pub fn running(&self) -> bool {
        self.running
    }
    fn memory_labels(&self) -> Result<Option<&BTreeMap<Text, Value>>> {
        let Some(config) = field(&self.value, "Config")? else {
            return Ok(None);
        };
        let labels = field(config, "Labels")?;
        if !legacy_json::truthy(labels) {
            return Ok(None);
        }
        let Some(Value(Node::Object(labels))) = labels else {
            return Err(RecoveryDataError::MemoryTarget);
        };
        Ok(Some(labels))
    }
    fn memory_label(&self, name: &str, expected: &str) -> Result<bool> {
        Ok(
            matches!(self.memory_labels()?.and_then(|labels|labels.get(&key(name))),Some(Value(Node::String(value))) if value.equals_ascii(expected)),
        )
    }
    pub fn assert_memory_namespace(
        &self,
        deployment: &str,
        session: &ProfileSessionId,
    ) -> Result<()> {
        if self.memory_label("reverie.worker", deployment)?
            && self.memory_label("reverie.session", session.as_str())?
        {
            Ok(())
        } else {
            Err(RecoveryDataError::MemoryTarget)
        }
    }
    pub fn assert_memory_policy(&self, expected: &WorkerPolicyDigest) -> Result<()> {
        if self.memory_label("reverie.worker-policy", &expected.to_hex())? {
            Ok(())
        } else {
            Err(RecoveryDataError::MemoryTarget)
        }
    }
    /// NativeObserver.limits reads Id only after all physical limits checks.
    /// Memory recovery ignores the returned binding, so preserve presence
    /// without inventing or imposing an inventory's canonical CID here.
    pub fn assert_native_result_data(
        &self,
    ) -> std::result::Result<(), crate::reservation_engine::EngineDataError> {
        if field(&self.value, "Id")
            .map_err(|_| crate::reservation_engine::EngineDataError::Structure)?
            .is_some()
        {
            Ok(())
        } else {
            Err(crate::reservation_engine::EngineDataError::Structure)
        }
    }
    pub fn fields_for_limits(
        &self,
    ) -> std::result::Result<
        crate::reservation_engine::NativeLimitFields<'_>,
        crate::reservation_engine::EngineDataError,
    > {
        crate::reservation_engine::NativeLimitFields::from_data(&self.value)
    }
}
