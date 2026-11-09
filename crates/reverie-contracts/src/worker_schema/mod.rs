//! Captured worker envelope/base and mount declarations, never a fully validated
//! worker domain. Filesystem, feature and seccomp checks remain separate.
mod mounts;
use crate::legacy_json::{Node, Number, Text, Value};
use crate::storage_identity::MetadataText;
use crate::worker_config::EffectiveWorkerConfig;
pub use mounts::{WorkerMount, validate_rootless_mounts};
use reverie_core::ids::ProfileSessionId;
use reverie_core::worker_schema::{WorkerBase, WorkerIds, WorkerRuleError};
use std::collections::BTreeMap;
use std::fmt;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WorkerSchemaError {
    Header,
    Base,
    Path,
    Maintenance,
    Mount,
    Rule(WorkerRuleError),
    Resources(crate::broker_resources::ResourceConfigError),
    Device(crate::device_policy::DeviceConfigError),
    Perf(crate::task_perf_v1::TaskPerfError),
    Lease(crate::lease_policy::LeaseDataError),
}
impl fmt::Display for WorkerSchemaError {
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(output, "{self:?}")
    }
}
impl std::error::Error for WorkerSchemaError {}
impl From<WorkerRuleError> for WorkerSchemaError {
    fn from(error: WorkerRuleError) -> Self {
        Self::Rule(error)
    }
}
impl From<crate::broker_resources::ResourceConfigError> for WorkerSchemaError {
    fn from(error: crate::broker_resources::ResourceConfigError) -> Self {
        Self::Resources(error)
    }
}
type Result<T> = std::result::Result<T, WorkerSchemaError>;
type Object = BTreeMap<Text, Value>;
const REQUIRED: [&str; 22] = [
    "version",
    "deployment",
    "image",
    "serverContainer",
    "socket",
    "stateRoot",
    "companyFile",
    "companyRoot",
    "scratchRoot",
    "apiSocketRoot",
    "budgetMode",
    "uid",
    "gid",
    "memoryMiB",
    "poolMemoryMiB",
    "poolTasksMax",
    "cgroupParent",
    "pidsLimit",
    "cpus",
    "maxWorkers",
    "mounts",
    "maintenanceSessions",
];
const OPTIONAL: [&str; 18] = [
    "workerPoolProvider",
    "gpuGrants",
    "employeeGpuGrants",
    "employeePerfPolicies",
    "employeeMemoryPolicies",
    "laptopSwapPoolMiB",
    "softLimitHelperSocket",
    "sessionResources",
    "employeeResources",
    "rootlessDocker",
    "goalPrivateConfig",
    "opsConfig",
    "leaseAcceptance",
    "commandTelemetry",
    "coldTemporaryCleanup",
    "resourceReservations",
    "browserJobPolicy",
    "resourceActorConfig",
];

/// Retains exact captured data, including version bool/float provenance and
/// dormant arbitrary option values. No defaults are inserted. This is one
/// complete pure unit, not the result of worker.validate_config.
pub struct WorkerEnvelope {
    config: EffectiveWorkerConfig,
    base: WorkerBase,
    mounts: Vec<WorkerMount>,
    maintenance: Vec<ProfileSessionId>,
    paths: [MetadataText; 6],
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WorkerPath {
    Socket,
    StateRoot,
    CompanyFile,
    CompanyRoot,
    ScratchRoot,
    ApiSocketRoot,
}
impl WorkerEnvelope {
    pub fn capture(config: EffectiveWorkerConfig) -> Result<Self> {
        Self::capture_observing(config, |_, _| Ok(()))
    }
    /// Interleave each declaration with the caller's readonly source observation,
    /// before checking the next declaration. This still constructs envelope DATA,
    /// not a native grant. The callback cannot make the envelope authoritative.
    pub fn capture_observing<E: From<WorkerSchemaError>>(
        config: EffectiveWorkerConfig,
        mut observe: impl FnMut(&WorkerMount, WorkerPaths<'_>) -> std::result::Result<(), E>,
    ) -> std::result::Result<Self, E> {
        let fields = object(config.as_value()).ok_or(WorkerSchemaError::Header)?;
        header(fields)?;
        let base = base(fields, &config)?;
        paths(fields)?;
        let paths = [
            "socket",
            "stateRoot",
            "companyFile",
            "companyRoot",
            "scratchRoot",
            "apiSocketRoot",
        ]
        .map(|name| {
            // paths() checked every field's string shape without normalization.
            MetadataText::from_text(
                text(field(fields, name))
                    .expect("checked base path")
                    .clone(),
            )
        });
        let maintenance = maintenance(fields)?;
        socket_bound(fields)?;
        let mounts =
            mounts::declarations_observed(fields, |mount| observe(mount, WorkerPaths(&paths)))?;
        Ok(Self {
            config,
            base,
            mounts,
            maintenance,
            paths,
        })
    }
    pub fn configuration(&self) -> &EffectiveWorkerConfig {
        &self.config
    }
    pub fn into_configuration(self) -> EffectiveWorkerConfig {
        self.config
    }
    pub fn base(&self) -> &WorkerBase {
        &self.base
    }
    pub fn mounts(&self) -> &[WorkerMount] {
        &self.mounts
    }
    pub fn maintenance_sessions(&self) -> &[ProfileSessionId] {
        &self.maintenance
    }
    pub fn path(&self, path: WorkerPath) -> &MetadataText {
        &self.paths[path_index(path)]
    }
    pub fn paths(&self) -> WorkerPaths<'_> {
        WorkerPaths(&self.paths)
    }
    /// Reuse existing purpose owners without copying data. This checks only
    /// these feature maps/options, not the unported option/native obligations.
    pub fn validate_feature_policies(&self) -> Result<()> {
        let fields = object(self.config.as_value()).ok_or(WorkerSchemaError::Header)?;
        if field(fields, "employeeMemoryPolicies").is_some()
            || field(fields, "laptopSwapPoolMiB").is_some()
        {
            crate::device_policy::memory::validate(&self.config)
                .map_err(WorkerSchemaError::Device)?;
        }
        crate::device_policy::gpu::validate_config(&self.config)
            .map_err(WorkerSchemaError::Device)?;
        crate::task_perf_v1::TaskPerfConfiguration::validate(&self.config)
            .map_err(WorkerSchemaError::Perf)?;
        crate::broker_resources::validate_maps(self.config.as_value())?;
        crate::lease_policy::LeaseConfig::validate_option(&self.config)
            .map_err(WorkerSchemaError::Lease)?;
        Ok(())
    }
}
/// Borrowed original path strings, with no filesystem qualification.
#[derive(Clone, Copy)]
pub struct WorkerPaths<'a>(&'a [MetadataText; 6]);
impl WorkerPaths<'_> {
    pub fn path(&self, path: WorkerPath) -> &MetadataText {
        &self.0[path_index(path)]
    }
}
fn path_index(path: WorkerPath) -> usize {
    match path {
        WorkerPath::Socket => 0,
        WorkerPath::StateRoot => 1,
        WorkerPath::CompanyFile => 2,
        WorkerPath::CompanyRoot => 3,
        WorkerPath::ScratchRoot => 4,
        WorkerPath::ApiSocketRoot => 5,
    }
}
pub(crate) fn validate_header(config: &EffectiveWorkerConfig) -> Result<()> {
    header(object(config.as_value()).ok_or(WorkerSchemaError::Header)?)
}
fn key(value: &str) -> Text {
    Text(value.bytes().map(u32::from).collect())
}
fn field<'a>(fields: &'a Object, name: &str) -> Option<&'a Value> {
    fields.get(&key(name))
}
fn object(value: &Value) -> Option<&Object> {
    if let Node::Object(value) = &value.0 {
        Some(value)
    } else {
        None
    }
}
fn text(value: Option<&Value>) -> Result<&Text> {
    if let Some(Value(Node::String(value))) = value {
        Ok(value)
    } else {
        Err(WorkerSchemaError::Base)
    }
}
fn scalar(value: Option<&Value>) -> Result<String> {
    text(value)?
        .0
        .iter()
        .map(|&c| char::from_u32(c))
        .collect::<Option<_>>()
        .ok_or(WorkerSchemaError::Base)
}
fn integer(fields: &Object, name: &str) -> Result<u32> {
    match field(fields, name) {
        Some(Value(Node::Number(Number::Integer(value)))) => {
            value.parse().map_err(|_| WorkerSchemaError::Base)
        }
        _ => Err(WorkerSchemaError::Base),
    }
}
fn header(fields: &Object) -> Result<()> {
    if !REQUIRED.iter().all(|name| field(fields, name).is_some())
        || fields.keys().any(|name| {
            !REQUIRED
                .iter()
                .chain(&OPTIONAL)
                .any(|value| name.equals_ascii(value))
        })
    {
        return Err(WorkerSchemaError::Header);
    }
    // Python's `value != 1` accepts bool true and float 1.0, without rewriting.
    if field(fields, "version")
        .is_none_or(|value| crate::legacy_json::numeric_key(&value.0).as_deref() != Some("1"))
    {
        return Err(WorkerSchemaError::Header);
    }
    Ok(())
}
fn base(fields: &Object, config: &EffectiveWorkerConfig) -> Result<WorkerBase> {
    // Selection remains DATA. It permits only the exact derived spelling;
    // installation, maintenance and allocation are checked by their owners.
    let provider = crate::worker_pool::WorkerPoolProvider::from_config(config)
        .map_err(|_| WorkerSchemaError::Base)?;
    let parent = provider.as_ref().map_or_else(
        || "reverie-workers.slice".to_owned(),
        |selected| selected.policy().parent_slice(),
    );
    if !text(field(fields, "cgroupParent"))?.equals_ascii(&parent) {
        return Err(WorkerSchemaError::Base);
    }
    let resources = crate::broker_resources::template_fields(fields)?
        .resolve(None)
        .map_err(|_| WorkerSchemaError::Base)?;
    Ok(WorkerBase::try_new(
        scalar(field(fields, "deployment"))?,
        scalar(field(fields, "serverContainer"))?,
        scalar(field(fields, "image"))?,
        WorkerIds::try_new(integer(fields, "uid")?, integer(fields, "gid")?)?,
        u8::try_from(integer(fields, "maxWorkers")?).map_err(|_| WorkerSchemaError::Base)?,
        resources,
    )?)
}
fn paths(fields: &Object) -> Result<()> {
    for name in [
        "socket",
        "stateRoot",
        "companyFile",
        "companyRoot",
        "scratchRoot",
        "apiSocketRoot",
    ] {
        let value = text(field(fields, name)).map_err(|_| WorkerSchemaError::Path)?;
        if value.0.first() != Some(&47) || value.0.contains(&0) {
            return Err(WorkerSchemaError::Path);
        }
    }
    Ok(())
}
fn socket_bound(fields: &Object) -> Result<()> {
    if scalar(field(fields, "socket"))
        .map_err(|_| WorkerSchemaError::Path)?
        .len()
        > 100
    {
        return Err(WorkerSchemaError::Path);
    }
    Ok(())
}
fn maintenance(fields: &Object) -> Result<Vec<ProfileSessionId>> {
    let Some(Value(Node::Array(values))) = field(fields, "maintenanceSessions") else {
        return Err(WorkerSchemaError::Maintenance);
    };
    values
        .iter()
        .map(|value| {
            ProfileSessionId::parse(
                &scalar(Some(value)).map_err(|_| WorkerSchemaError::Maintenance)?,
            )
            .map_err(|_| WorkerSchemaError::Maintenance)
        })
        .collect()
}
