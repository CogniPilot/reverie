//! Resource-map staging of captured broker data. No file, owner or host authority.
//!
//! This bridges the pure core rules to the existing configuration shape. It is
//! not a worker configuration validator or an effective-policy resolver.
use crate::legacy_json::{self, Node, Number, Text, Value};
use reverie_core::ValueError;
use reverie_core::ids::{ProfileEmployeeId, ProfileSessionId};
use reverie_core::profiles::{MAX_PROFILES, ProfileDocument};
use reverie_core::resource_projection::{
    MAX_SESSION_POLICIES, ProfileStageRequest, ProjectionError, ResourceProjection,
    StagedResourceProjection,
};
use reverie_core::resources::{
    BudgetMode, CpuQuota, CpuRepresentation, PoolLimits, ResourceTemplate,
};
use std::collections::BTreeMap;
use std::fmt;

type Object = BTreeMap<Text, Value>;
type Result<T> = std::result::Result<T, ResourceConfigError>;
const FIELDS: [&str; 6] = [
    "budgetMode",
    "memoryMiB",
    "pidsLimit",
    "cpus",
    "poolMemoryMiB",
    "poolTasksMax",
];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ResourceConfigError {
    InvalidJson,
    DuplicateKey,
    NonfiniteData,
    StoreBound,
    ExpectedObject,
    ResourceShape,
    Value(ValueError),
    Projection(ProjectionError),
}
impl ResourceConfigError {
    pub fn code(self) -> &'static str {
        match self {
            Self::InvalidJson => "BROKER_CONFIG_JSON",
            Self::DuplicateKey => "DUPLICATE_KEY",
            Self::NonfiniteData => "NONFINITE_JSON",
            Self::StoreBound => "STORE_BOUND",
            Self::ExpectedObject => "BROKER_CONFIG_OBJECT",
            Self::ResourceShape => "RESOURCE_CONFIG_SHAPE",
            Self::Value(error) => error.code(),
            Self::Projection(error) => error.code(),
        }
    }
}
impl From<ValueError> for ResourceConfigError {
    fn from(value: ValueError) -> Self {
        Self::Value(value)
    }
}
impl From<ProjectionError> for ResourceConfigError {
    fn from(value: ProjectionError) -> Self {
        Self::Projection(value)
    }
}
impl fmt::Display for ResourceConfigError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code())
    }
}
impl std::error::Error for ResourceConfigError {}

/// Immutable captured data, with both resource maps checked under the existing
/// reservation-key-presence rule. Other fields are retained, not authorized.
pub struct BrokerResourceConfig {
    data: Value,
    projection: ResourceProjection,
}
/// Finite duplicate-free UTF-8 object data, as supplied by the current broker.
/// Legacy profile staging rejects nonfinite data even in unrelated fields;
/// this is intentionally stricter than the general worker hash codec.
pub fn decode(raw: &[u8]) -> Result<BrokerResourceConfig> {
    std::str::from_utf8(raw).map_err(|_| ResourceConfigError::InvalidJson)?;
    let data = legacy_json::decode_utf8(raw).map_err(|error| match error {
        legacy_json::Error::InvalidJson => ResourceConfigError::InvalidJson,
        legacy_json::Error::DuplicateKey => ResourceConfigError::DuplicateKey,
    })?;
    finite(&data)?;
    // ProfileStore.stage_config clones its captured config through the same
    // compact ASCII 128-KiB decoder used by the legacy profile store.
    if crate::worker_config::compact_data(&data).len() > crate::profiles_v1::MAX_BYTES {
        return Err(ResourceConfigError::StoreBound);
    }
    let projection = projection(&data)?;
    Ok(BrokerResourceConfig { data, projection })
}

pub(crate) fn projection(data: &Value) -> Result<ResourceProjection> {
    let root = object(data).ok_or(ResourceConfigError::ExpectedObject)?;
    let sessions = map(
        root,
        "sessionResources",
        MAX_SESSION_POLICIES,
        ProjectionError::SessionPolicyCount,
        ProfileSessionId::parse,
    )?;
    let employees = map(
        root,
        "employeeResources",
        MAX_PROFILES,
        ProjectionError::EmployeePolicyCount,
        ProfileEmployeeId::parse,
    )?;
    let pool = if root.contains_key(&key("resourceReservations")) {
        Some(PoolLimits::try_new(
            integer(root, "poolMemoryMiB")?,
            integer(root, "poolTasksMax")?,
        )?)
    } else {
        None
    };
    Ok(ResourceProjection::try_new(sessions, employees, pool)?)
}
impl BrokerResourceConfig {
    pub fn resources(&self) -> &ResourceProjection {
        &self.projection
    }
    /// Mutate only the selected resource-map entries in this owned data copy.
    /// The application must retain and finish its canonical profile read guard,
    /// then resolve all host-backed grants before constructing an effective hash.
    pub fn stage(
        mut self,
        document: &ProfileDocument,
        request: &ProfileStageRequest,
    ) -> Result<StagedBrokerResources> {
        let staged = self.projection.stage(document, request)?;
        let employee = staged.profile().binding().employee();
        let target = staged.target_session();
        let resources = &staged.projection().employees()[employee];
        let Node::Object(root) = &mut self.data.0 else {
            unreachable!("checked object")
        };
        replace(root, "employeeResources", employee.as_str(), resources);
        replace(root, "sessionResources", target.as_str(), resources);
        Ok(StagedBrokerResources {
            data: self.data,
            staged,
        })
    }
}
/// A broker-config candidate only: no digest, native permit, file or wire codec.
pub struct StagedBrokerResources {
    data: Value,
    staged: StagedResourceProjection,
}
impl StagedBrokerResources {
    /// Move the candidate into the application workflow without a JSON
    /// serialize/parse clone, which could change raw surrogate codepoints.
    pub fn into_configuration(
        self,
    ) -> (
        crate::worker_config::EffectiveWorkerConfig,
        StagedResourceProjection,
    ) {
        let mut data = self.data;
        let Node::Object(fields) = std::mem::replace(&mut data.0, Node::Null) else {
            unreachable!("checked object");
        };
        (
            crate::worker_config::EffectiveWorkerConfig::from_object(fields),
            self.staged,
        )
    }
    /// Private application data, potentially containing protected configuration.
    /// Do not expose this as a browser response or infer a current-host receipt.
    pub fn configuration_bytes(&self) -> Vec<u8> {
        crate::worker_config::encode_data(&self.data)
    }
    pub fn resources(&self) -> &StagedResourceProjection {
        &self.staged
    }
}

fn key(value: &str) -> Text {
    Text(value.chars().map(u32::from).collect())
}
fn object(value: &Value) -> Option<&Object> {
    if let Node::Object(value) = &value.0 {
        Some(value)
    } else {
        None
    }
}
fn integer(value: &Object, field: &str) -> Result<u32> {
    match value.get(&key(field)) {
        Some(Value(Node::Number(Number::Integer(value)))) => value
            .parse()
            .map_err(|_| ResourceConfigError::ResourceShape),
        _ => Err(ResourceConfigError::ResourceShape),
    }
}
fn template(value: &Value) -> Result<ResourceTemplate> {
    let fields = object(value).ok_or(ResourceConfigError::ResourceShape)?;
    if fields.len() != FIELDS.len() || !FIELDS.iter().all(|field| fields.contains_key(&key(field)))
    {
        return Err(ResourceConfigError::ResourceShape);
    }
    template_fields(fields)
}
pub(crate) fn template_fields(fields: &Object) -> Result<ResourceTemplate> {
    let mode = match fields.get(&key("budgetMode")) {
        Some(Value(Node::String(value))) if value.equals_ascii("admission") => {
            BudgetMode::Admission
        }
        Some(Value(Node::String(value))) if value.equals_ascii("pool") => BudgetMode::Pool,
        _ => return Err(ResourceConfigError::ResourceShape),
    };
    let cpu = match fields.get(&key("cpus")) {
        Some(Value(Node::Number(Number::Integer(value)))) => CpuQuota::from_integer(
            value
                .parse()
                .map_err(|_| ResourceConfigError::ResourceShape)?,
        )?,
        Some(Value(Node::Number(Number::Float(value)))) => CpuQuota::from_float(*value)?,
        _ => return Err(ResourceConfigError::ResourceShape),
    };
    Ok(ResourceTemplate::try_new(
        mode,
        integer(fields, "memoryMiB")?,
        integer(fields, "pidsLimit")?,
        cpu,
        integer(fields, "poolMemoryMiB")?,
        integer(fields, "poolTasksMax")?,
    )?)
}
fn map<K: Ord>(
    root: &Object,
    field: &str,
    maximum: usize,
    count_error: ProjectionError,
    parse_id: impl Fn(&str) -> std::result::Result<K, ValueError>,
) -> Result<BTreeMap<K, ResourceTemplate>> {
    let Some(value) = root.get(&key(field)) else {
        return Ok(BTreeMap::new());
    };
    let values = object(value).ok_or(ResourceConfigError::ResourceShape)?;
    if values.len() > maximum {
        return Err(count_error.into());
    }
    let mut result = BTreeMap::new();
    for (id, value) in values {
        let id: String =
            id.0.iter()
                .map(|&cp| char::from_u32(cp))
                .collect::<Option<_>>()
                .ok_or(ResourceConfigError::ResourceShape)?;
        result.insert(parse_id(&id)?, template(value)?);
    }
    Ok(result)
}
fn finite(data: &Value) -> Result<()> {
    let mut pending = vec![data];
    while let Some(value) = pending.pop() {
        match &value.0 {
            Node::Number(Number::Nan | Number::PositiveInfinity | Number::NegativeInfinity) => {
                return Err(ResourceConfigError::NonfiniteData);
            }
            Node::Array(values) => pending.extend(values),
            Node::Object(values) => pending.extend(values.values()),
            _ => {}
        }
    }
    Ok(())
}
fn replace(root: &mut Object, field: &str, id: &str, resource: &ResourceTemplate) {
    let value = root
        .entry(key(field))
        .or_insert_with(|| Value(Node::Object(BTreeMap::new())));
    let Node::Object(values) = &mut value.0 else {
        unreachable!("checked resource map")
    };
    values.insert(key(id), Value(Node::Object(resource_fields(resource))));
}
pub(crate) fn resource_fields(resource: &ResourceTemplate) -> Object {
    let mut fields = BTreeMap::new();
    let mode = match resource.budget_mode() {
        BudgetMode::Admission => "admission",
        BudgetMode::Pool => "pool",
    };
    fields.insert(key("budgetMode"), Value(Node::String(key(mode))));
    for (name, value) in [
        ("memoryMiB", resource.memory_mib()),
        ("pidsLimit", resource.pids_limit()),
        ("poolMemoryMiB", resource.pool_memory_mib()),
        ("poolTasksMax", resource.pool_tasks_max()),
    ] {
        fields.insert(
            key(name),
            Value(Node::Number(Number::Integer(value.to_string()))),
        );
    }
    let cpu = match resource.cpus().representation() {
        CpuRepresentation::Integer(value) => Number::Integer(value.to_string()),
        CpuRepresentation::Float(value) => Number::Float(value),
    };
    fields.insert(key("cpus"), Value(Node::Number(cpu)));
    fields
}
