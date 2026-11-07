//! Broker.allowed's current/detached execution intent DATA. These purpose views
//! deliberately do not reuse registry/storage eligibility's stronger schema.
use crate::{
    legacy_json::{self, Node, Text, Value},
    storage_identity::{Metadata, MetadataText},
    worker_config::EffectiveWorkerConfig,
};
use reverie_core::ids::ProfileSessionId;
use std::{collections::BTreeMap, fmt};
type Object = BTreeMap<Text, Value>;
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum IntentDataError {
    CompanyUnavailable,
    CompanyStructure,
    PlanUnavailable,
    Configuration,
}
impl IntentDataError {
    pub fn code(self) -> &'static str {
        match self {
            Self::CompanyUnavailable => "WORKER_COMPANY_UNAVAILABLE",
            Self::CompanyStructure => "WORKER_COMPANY_STRUCTURE",
            Self::PlanUnavailable => "WORKER_PLAN_UNAVAILABLE",
            Self::Configuration => "WORKER_INTENT_CONFIGURATION",
        }
    }
}
impl fmt::Display for IntentDataError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.write_str(self.code())
    }
}
impl std::error::Error for IntentDataError {}
fn key(value: &str) -> Text {
    Text(value.chars().map(u32::from).collect())
}
fn field<'a>(value: &'a Object, name: &str) -> Option<&'a Value> {
    value.get(&key(name))
}
fn object(value: &Value) -> Option<&Object> {
    if let Node::Object(value) = &value.0 {
        Some(value)
    } else {
        None
    }
}
fn matches(value: Option<&Value>, expected: &str) -> bool {
    matches!(value,Some(Value(Node::String(value))) if value.equals_ascii(expected))
}
/// Borrow only selected settings at the original observation phase. In
/// particular UID is not read until the detached plan-journal fallback.
pub struct WorkerIntentConfiguration<'a>(&'a EffectiveWorkerConfig);
impl<'a> WorkerIntentConfiguration<'a> {
    pub fn new(config: &'a EffectiveWorkerConfig) -> Self {
        Self(config)
    }
    pub fn company_file(&self) -> Result<MetadataText, IntentDataError> {
        let value = object(self.0.as_value()).and_then(|value| field(value, "companyFile"));
        match value {
            Some(Value(Node::String(value))) => Ok(MetadataText::from_text(value.clone())),
            _ => Err(IntentDataError::CompanyUnavailable),
        }
    }
    /// Accepted worker configurations have an unsigned, non-boolean UID. This
    /// conversion is data validation and cannot confer file or execution power.
    pub fn uid(&self) -> Result<u32, IntentDataError> {
        match object(self.0.as_value()).and_then(|value| field(value, "uid")) {
            Some(Value(Node::Number(legacy_json::Number::Integer(value)))) => {
                value.parse().map_err(|_| IntentDataError::Configuration)
            }
            _ => Err(IntentDataError::Configuration),
        }
    }
}
/// Path.read_text's UTF-8/universal-newline text followed by default
/// json.loads(str): last-key-wins, 4300-digit integers, nonfinite constants.
pub fn current_allowed(
    raw: &[u8],
    session: &ProfileSessionId,
) -> Result<Option<bool>, IntentDataError> {
    let text = std::str::from_utf8(raw).map_err(|_| IntentDataError::CompanyUnavailable)?;
    let text = text.replace("\r\n", "\n").replace('\r', "\n");
    let value = legacy_json::decode_python_str(text.as_bytes())
        .map_err(|_| IntentDataError::CompanyUnavailable)?;
    let root = object(&value).ok_or(IntentDataError::CompanyStructure)?;
    let employees = field(root, "employees").ok_or(IntentDataError::CompanyUnavailable)?;
    let rows = match &employees.0 {
        Node::Array(rows) => rows,
        Node::Object(rows) if rows.is_empty() => return Ok(None),
        Node::String(text) if text.0.is_empty() => return Ok(None),
        _ => return Err(IntentDataError::CompanyStructure),
    };
    for row in rows {
        let row = object(row).ok_or(IntentDataError::CompanyStructure)?;
        if matches(field(row, "sessionId"), session.as_str()) {
            return Ok(Some(
                !legacy_json::truthy(field(row, "onVacation"))
                    && !matches!(field(row, "desiredRunning"), Some(Value(Node::Bool(false)))),
            ));
        }
    }
    Ok(None)
}
/// The fallback's strict metadata reader has already supplied complete DATA.
/// No move-count/known-phase/UUID/employee constraints are added to this owner.
pub fn detached_allowed(
    metadata: &Metadata,
    session: &ProfileSessionId,
) -> Result<bool, IntentDataError> {
    let Node::Array(rows) = &metadata.as_value().0 else {
        return Err(IntentDataError::PlanUnavailable);
    };
    for row in rows {
        let row = object(row).ok_or(IntentDataError::PlanUnavailable)?;
        let phase = field(row, "phase");
        let source_stop = matches(field(row, "oldSession"), session.as_str())
            && (matches!(
                field(row, "sourceStopRequested"),
                Some(Value(Node::Bool(true)))
            ) || matches(phase, "stopping")
                || matches(phase, "completed"));
        if source_stop
            || (matches(field(row, "newSession"), session.as_str()) && matches(phase, "failed"))
        {
            return Ok(false);
        }
    }
    Ok(true)
}
