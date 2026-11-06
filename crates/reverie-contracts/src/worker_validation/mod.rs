//! Ordered worker-validator data seams. Native observations belong to host.
mod ops;
use crate::legacy_json::{Node, Number, Text, Value};
use crate::storage_identity::MetadataText;
use crate::worker_config::EffectiveWorkerConfig;
pub use ops::{OpsBindingConfig, OpsPrivateDocument};
use reverie_core::worker_options::{ReservationOption, WorkerOptionError, WorkerPathPolicy};
use std::{collections::BTreeMap, fmt};

type Object = BTreeMap<Text, Value>;
type Result<T> = std::result::Result<T, WorkerValidationError>;
#[derive(Debug)]
pub enum WorkerValidationError {
    Schema(crate::worker_schema::WorkerSchemaError),
    Option(WorkerOptionError),
    Memory(crate::device_policy::DeviceConfigError),
    Gpu(crate::device_policy::DeviceConfigError),
    Perf(crate::task_perf_v1::TaskPerfError),
    Resources(crate::broker_resources::ResourceConfigError),
    Ops,
}
impl fmt::Display for WorkerValidationError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(out, "{self:?}")
    }
}
impl std::error::Error for WorkerValidationError {}
impl From<WorkerOptionError> for WorkerValidationError {
    fn from(value: WorkerOptionError) -> Self {
        Self::Option(value)
    }
}

#[derive(Clone, Copy)]
pub enum PrivateSelector {
    BrowserJob,
    ResourceActor,
}
pub struct WorkerValidationData<'a>(&'a EffectiveWorkerConfig);
impl<'a> WorkerValidationData<'a> {
    pub fn new(config: &'a EffectiveWorkerConfig) -> Self {
        Self(config)
    }
    pub fn header(&self) -> Result<()> {
        crate::worker_schema::validate_header(self.0).map_err(WorkerValidationError::Schema)
    }
    pub fn helper_and_memory(&self) -> Result<()> {
        let fields = root(self.0);
        optional_path(fields, "softLimitHelperSocket", WorkerPathPolicy::Helper)?;
        if field(fields, "employeeMemoryPolicies").is_some()
            || field(fields, "laptopSwapPoolMiB").is_some()
        {
            crate::device_policy::memory::validate(self.0)
                .map_err(WorkerValidationError::Memory)?;
        }
        Ok(())
    }
    pub fn reservation(&self) -> Result<Option<ReservationOption>> {
        let Some(value) = field(root(self.0), "resourceReservations") else {
            return Ok(None);
        };
        let error = WorkerOptionError::Reservation;
        let fields = object(value).ok_or(error)?;
        shape(
            fields,
            &[
                "directory",
                "companyId",
                "poolId",
                "ownerScopeDigest",
                "hostReserveMiB",
            ],
        )
        .map_err(|_| error)?;
        let value = ReservationOption::try_new(
            &text(field(fields, "directory")).map_err(|_| error)?.0,
            &scalar(field(fields, "companyId")).map_err(|_| error)?,
            &scalar(field(fields, "poolId")).map_err(|_| error)?,
            &scalar(field(fields, "ownerScopeDigest")).map_err(|_| error)?,
            integer(field(fields, "hostReserveMiB")).map_err(|_| error)?,
        )?;
        Ok(Some(value))
    }
    pub fn ops_path(&self) -> Result<Option<MetadataText>> {
        optional_path(root(self.0), "opsConfig", WorkerPathPolicy::Ops)
    }
    pub fn selector(&self, selected: PrivateSelector) -> Result<Option<MetadataText>> {
        let name = match selected {
            PrivateSelector::BrowserJob => "browserJobPolicy",
            PrivateSelector::ResourceActor => "resourceActorConfig",
        };
        optional_path(root(self.0), name, WorkerPathPolicy::Selector)
    }
    pub fn telemetry_and_maps(&self) -> Result<()> {
        crate::command_telemetry::configuration(self.0)?;
        crate::device_policy::gpu::validate_config(self.0).map_err(WorkerValidationError::Gpu)?;
        crate::task_perf_v1::TaskPerfConfiguration::validate(self.0)
            .map_err(WorkerValidationError::Perf)?;
        crate::broker_resources::validate_maps(self.0.as_value())
            .map_err(WorkerValidationError::Resources)?;
        Ok(())
    }
    pub fn goal_path(&self) -> Result<()> {
        optional_path(root(self.0), "goalPrivateConfig", WorkerPathPolicy::Goal)?;
        Ok(())
    }
    /// Extract precisely the configured exposure roots used by OPS binding
    /// validation. They have not yet passed the later base/mount rules.
    pub fn ops_exposure_roots(&self) -> Result<Vec<MetadataText>> {
        let fields = root(self.0);
        let mut sources = mount_sources(fields)?;
        sources.push(metadata(field(fields, "scratchRoot"))?);
        for (name, suffix) in [
            ("stateRoot", "employees"),
            ("companyRoot", "console/accounts"),
        ] {
            let base = reverie_core::posix_path::PosixPath::try_new(&text(field(fields, name))?.0)
                .map_err(|_| WorkerValidationError::Ops)?;
            sources.push(MetadataText::from_text(Text(
                base.join(&reverie_core::posix_path::PosixPath::from_scalar_text(
                    suffix,
                ))
                .codepoints(),
            )));
        }
        Ok(sources)
    }
    pub fn company_file(&self) -> Result<MetadataText> {
        metadata(field(root(self.0), "companyFile"))
    }
    pub fn cold(&self) -> Result<Option<ColdPolicy<'a>>> {
        ColdPolicy::capture(self.0)
    }
}

pub struct ColdPolicy<'a> {
    config: &'a EffectiveWorkerConfig,
    directories: &'a [Value],
}
impl<'a> ColdPolicy<'a> {
    fn capture(config: &'a EffectiveWorkerConfig) -> Result<Option<Self>> {
        let Some(value) = field(root(config), "coldTemporaryCleanup") else {
            return Ok(None);
        };
        if matches!(value.0, Node::Null) {
            return Ok(None);
        }
        let error = WorkerOptionError::Cold;
        let value = object(value).ok_or(error)?;
        if !["version", "enabled", "hostLeaseDirectories"]
            .iter()
            .all(|name| field(value, name).is_some())
            || value.keys().any(|name| {
                !["version", "enabled", "hostLeaseDirectories", "strategy"]
                    .iter()
                    .any(|v| name.equals_ascii(v))
            })
            || integer(field(value, "version")).ok() != Some(1)
            || !matches!(field(value, "enabled"), Some(Value(Node::Bool(true))))
        {
            return Err(error.into());
        }
        if let Some(value) = field(value, "strategy") {
            let value = scalar(Some(value)).map_err(|_| error)?;
            if !["clear", "retain-and-replace"].contains(&value.as_str()) {
                return Err(error.into());
            }
        }
        let Some(Value(Node::Array(directories))) = field(value, "hostLeaseDirectories") else {
            return Err(error.into());
        };
        if directories.len() > 16 {
            return Err(error.into());
        }
        Ok(Some(Self {
            config,
            directories,
        }))
    }
    pub fn len(&self) -> usize {
        self.directories.len()
    }
    pub fn is_empty(&self) -> bool {
        self.directories.is_empty()
    }
    pub fn directory(&self, index: usize) -> Result<MetadataText> {
        let value = text(self.directories.get(index)).map_err(|_| WorkerOptionError::Cold)?;
        WorkerPathPolicy::Cold.check(&value.0)?;
        Ok(MetadataText::from_text(value.clone()))
    }
    pub fn protected_roots(&self) -> Result<(Vec<MetadataText>, Vec<MetadataText>)> {
        let fields = root(self.config);
        let paths = ["stateRoot", "scratchRoot"]
            .map(|name| metadata(field(fields, name)))
            .into_iter()
            .collect::<Result<_>>()?;
        Ok((paths, mount_sources(fields)?))
    }
}
fn optional_path(
    fields: &Object,
    name: &str,
    policy: WorkerPathPolicy,
) -> Result<Option<MetadataText>> {
    field(fields, name)
        .map(|value| {
            let value = text(Some(value)).map_err(|_| policy.refusal())?;
            policy.check(&value.0)?;
            Ok(MetadataText::from_text(value.clone()))
        })
        .transpose()
}
fn mount_sources(fields: &Object) -> Result<Vec<MetadataText>> {
    let Some(Value(Node::Array(values))) = field(fields, "mounts") else {
        return Err(WorkerValidationError::Ops);
    };
    values
        .iter()
        .map(|value| {
            metadata(field(
                object(value).ok_or(WorkerValidationError::Ops)?,
                "source",
            ))
        })
        .collect()
}
fn root(config: &EffectiveWorkerConfig) -> &Object {
    object(config.as_value()).expect("worker codec object")
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
        Err(WorkerValidationError::Ops)
    }
}
fn metadata(value: Option<&Value>) -> Result<MetadataText> {
    Ok(MetadataText::from_text(text(value)?.clone()))
}
fn scalar(value: Option<&Value>) -> Result<String> {
    text(value)?
        .0
        .iter()
        .map(|&c| char::from_u32(c))
        .collect::<Option<_>>()
        .ok_or(WorkerValidationError::Ops)
}
fn integer(value: Option<&Value>) -> Result<u32> {
    if let Some(Value(Node::Number(Number::Integer(value)))) = value {
        value.parse().map_err(|_| WorkerValidationError::Ops)
    } else {
        Err(WorkerValidationError::Ops)
    }
}
fn shape(fields: &Object, names: &[&str]) -> Result<()> {
    if fields.len() == names.len() && names.iter().all(|name| field(fields, name).is_some()) {
        Ok(())
    } else {
        Err(WorkerValidationError::Ops)
    }
}
