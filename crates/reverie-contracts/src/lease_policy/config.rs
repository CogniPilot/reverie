use super::*;
use crate::worker_config::{self, EffectiveWorkerConfig};
use reverie_core::ids::{ProfileEmployeeId, ProfileSessionId};
use reverie_core::lease_policy::{
    LeaseAcceptance, LeaseControlContext, LeaseMountView, LeaseRelativePath, PEER_TARGET,
};

pub struct LeaseConfig {
    config: EffectiveWorkerConfig,
    option: Option<LeaseAcceptance>,
}
impl LeaseConfig {
    pub fn capture(config: EffectiveWorkerConfig) -> Result<Self> {
        let option = Self::validate_option(&config)?;
        Ok(Self { config, option })
    }
    /// Borrowed pure option validation; no company or artifact observation.
    pub fn validate_option(config: &EffectiveWorkerConfig) -> Result<Option<LeaseAcceptance>> {
        let root = object(config.as_value())?;
        match field(root, "leaseAcceptance") {
            None | Some(Value(Node::Null)) => Ok(None),
            Some(value) => Ok(Some(option(root, value)?)),
        }
    }
    pub fn decode(raw: &[u8]) -> Result<Self> {
        Self::capture(worker_config::decode(raw).map_err(|error| match error {
            worker_config::WorkerConfigError::DuplicateKey => LeaseDataError::DuplicateKey,
            _ => LeaseDataError::Json,
        })?)
    }
    pub fn option(&self) -> Option<&LeaseAcceptance> {
        self.option.as_ref()
    }
    pub fn company_file(&self) -> Result<LeaseAbsolutePath> {
        absolute(field(object(self.config.as_value())?, "companyFile"))
    }
    /// This compares configured numeric data; it authenticates no principal.
    pub fn metadata_uid_matches(&self, uid: u32) -> bool {
        let Ok(root) = object(self.config.as_value()) else {
            return false;
        };
        let expected = uid.to_string();
        field(root, "uid")
            .and_then(|value| legacy_json::numeric_key(&value.0))
            .is_some_and(|value| value == expected)
    }
    /// Candidate data only. The native lease adapter must observe the immutable
    /// artifact before acknowledging a projection whose artifact_required is set.
    pub fn project(
        self,
        session: &ProfileSessionId,
        current: Option<&CurrentLeaseSession>,
    ) -> Result<LeaseProjection> {
        let Some(option) = self.option else {
            return Ok(LeaseProjection {
                config: self.config,
                artifact_required: None,
            });
        };
        let current = current.ok_or(LeaseDataError::EmployeeSelection)?;
        if current.employee() != option.employee() {
            return Err(LeaseDataError::SelectionMismatch);
        }
        let selected = current.session() == session;
        let mut value = self.config.into_value();
        let Node::Object(mut root) = std::mem::replace(&mut value.0, Node::Null) else {
            return Err(LeaseDataError::Config);
        };
        root.remove(&key("leaseAcceptance"));
        if selected {
            append_mount(&mut root, option.peer_binary())?;
        }
        Ok(LeaseProjection {
            config: EffectiveWorkerConfig::from_object(root),
            artifact_required: selected.then(|| option.peer_binary().clone()),
        })
    }
}
pub struct LeaseProjection {
    config: EffectiveWorkerConfig,
    artifact_required: Option<LeaseAbsolutePath>,
}
impl LeaseProjection {
    pub fn config(&self) -> &EffectiveWorkerConfig {
        &self.config
    }
    pub fn artifact_required(&self) -> Option<&LeaseAbsolutePath> {
        self.artifact_required.as_ref()
    }
    pub fn into_config(self) -> EffectiveWorkerConfig {
        self.config
    }
}
fn option(config: &Object, value: &Value) -> Result<LeaseAcceptance> {
    let value = object(value).map_err(|_| LeaseDataError::Option)?;
    if value.len() != 4
        || !["socket", "employeeId", "leaseSubdirectory", "peerBinary"]
            .iter()
            .all(|name| field(value, name).is_some())
    {
        return Err(LeaseDataError::Option);
    }
    let employee = text(field(value, "employeeId"))?
        .0
        .iter()
        .map(|&value| char::from_u32(value))
        .collect::<Option<String>>()
        .ok_or(LeaseDataError::Option)?;
    let employee = ProfileEmployeeId::parse(&employee).map_err(|_| LeaseDataError::Option)?;
    let context = LeaseControlContext::try_new(
        absolute(field(config, "stateRoot"))?,
        &text(field(config, "socket"))?.0,
        uid_positive(field(config, "uid")),
    )?;
    let mounts = mount_views(field(config, "mounts"))?;
    Ok(LeaseAcceptance::try_new(
        absolute(field(value, "socket"))?,
        employee,
        LeaseRelativePath::try_new(text(field(value, "leaseSubdirectory"))?.0.clone())?,
        absolute(field(value, "peerBinary"))?,
        &context,
        &mounts,
    )?)
}
fn mount_views(value: Option<&Value>) -> Result<Vec<LeaseMountView>> {
    let values = match value {
        None => return Ok(Vec::new()),
        Some(Value(Node::Array(values))) => values,
        Some(Value(Node::Object(values))) if values.is_empty() => return Ok(Vec::new()),
        Some(Value(Node::String(value))) if value.0.is_empty() => return Ok(Vec::new()),
        _ => return Err(LeaseDataError::Mounts),
    };
    values
        .iter()
        .map(|value| {
            let value = object(value).map_err(|_| LeaseDataError::Mounts)?;
            Ok(LeaseMountView::new(
                absolute(field(value, "source"))?,
                absolute(field(value, "destination"))?,
            ))
        })
        .collect()
}
fn append_mount(root: &mut Object, path: &LeaseAbsolutePath) -> Result<()> {
    let mut source = root.remove(&key("mounts")).ok_or(LeaseDataError::Mounts)?;
    let mut mounts = match std::mem::replace(&mut source.0, Node::Null) {
        Node::Array(values) => values,
        Node::Object(values) if values.is_empty() => Vec::new(),
        Node::String(value) if value.0.is_empty() => Vec::new(),
        _ => return Err(LeaseDataError::Mounts),
    };
    let grant = BTreeMap::from([
        (
            key("source"),
            Value(Node::String(Text(path.codepoints().to_vec()))),
        ),
        (key("destination"), Value(Node::String(key(PEER_TARGET)))),
        (key("readOnly"), Value(Node::Bool(true))),
    ]);
    mounts.push(Value(Node::Object(grant)));
    root.insert(key("mounts"), Value(Node::Array(mounts)));
    Ok(())
}
