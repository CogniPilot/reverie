use super::*;
use crate::worker_config::EffectiveWorkerConfig;
use reverie_core::ids::{ProfileEmployeeId, ProfileSessionId};
use reverie_core::posix_path::PosixPath;

/// Captured existing worker-domain DATA. This view is not the whole worker
/// validator, an owner grant or custody of any configured path.
pub struct ReservationConfiguration {
    config: EffectiveWorkerConfig,
}
impl ReservationConfiguration {
    pub fn capture(config: EffectiveWorkerConfig) -> Self {
        Self { config }
    }
    pub fn configuration(&self) -> &EffectiveWorkerConfig {
        &self.config
    }
    fn root(&self) -> &Object {
        object(self.config.as_value()).expect("worker object invariant")
    }
    pub fn deployment(&self) -> Result<String> {
        scalar(field(self.root(), "deployment"))
    }
    pub fn server_container(&self) -> Result<String> {
        scalar(field(self.root(), "serverContainer"))
    }
    pub fn uid(&self) -> Result<u32> {
        unsigned(field(self.root(), "uid"))?
            .as_str()
            .parse()
            .map_err(|_| EngineDataError::Policy)
    }
    pub fn memory_policies_enabled(&self) -> bool {
        legacy_json::truthy(field(self.root(), "employeeMemoryPolicies"))
            || crate::session_resources_v2::configured(&self.config)
    }
    pub fn pool_bytes(&self) -> Result<UnsignedInteger> {
        Ok(unsigned(field(self.root(), "poolMemoryMiB"))?.times(1_048_576))
    }
    pub fn cgroup_parent(&self) -> Result<String> {
        scalar(field(self.root(), "cgroupParent"))
    }
    pub fn reserve_bytes(&self) -> Result<UnsignedInteger> {
        let selected =
            object(field(self.root(), "resourceReservations").ok_or(EngineDataError::Policy)?)?;
        Ok(unsigned(field(selected, "hostReserveMiB"))?.times(1_048_576))
    }
    pub fn swap_pool_bytes(&self) -> Result<UnsignedInteger> {
        field(self.root(), "laptopSwapPoolMiB")
            .map(|value| unsigned(Some(value)))
            .transpose()
            .map(|value| {
                value
                    .unwrap_or_else(|| UnsignedInteger::from_u64(0))
                    .times(1_048_576)
            })
    }
    pub fn configured_sources(&self) -> Result<Vec<MetadataText>> {
        let Some(Value(Node::Array(mounts))) = field(self.root(), "mounts") else {
            return Err(EngineDataError::Mounts);
        };
        mounts
            .iter()
            .map(|mount| {
                text(field(object(mount)?, "source"))
                    .cloned()
                    .map(MetadataText::from_text)
                    .ok_or(EngineDataError::Mounts)
            })
            .collect()
    }
    pub fn control_paths(&self) -> Result<ControlPaths> {
        let selected =
            object(field(self.root(), "resourceReservations").ok_or(EngineDataError::Policy)?)?;
        let root = path(field(selected, "directory"))?;
        let binding = self
            .control_binding_paths()?
            .ok_or(EngineDataError::Policy)?;
        Ok(ControlPaths { root, binding })
    }
    /// Fixed marker/pending path DATA, independent of the optional control
    /// directory. The original configured() also accepts partial transport
    /// configuration without stateRoot; it does not invent a path in that case.
    pub fn control_binding_paths(&self) -> Result<Option<ControlBindingPaths>> {
        let Some(state) = field(self.root(), "stateRoot") else {
            return Ok(None);
        };
        let binding = path(Some(state))?.join(&PosixPath::from_scalar_text(
            "resource-reservation-control.json",
        ));
        let pending = binding.parent().join(&PosixPath::from_scalar_text(
            "resource-reservation-control.pending",
        ));
        Ok(Some(ControlBindingPaths { binding, pending }))
    }
    /// Reconstruct Python text from this same config and existing checked
    /// storage identity, without fsdecode changing untouched surrogate inputs.
    pub fn storage_text(&self, identity: StorageIdentityRef<'_>) -> Result<StoragePathText> {
        let suffix = match identity {
            StorageIdentityRef::Employee(value) => format!("employees/{}", value.as_str()),
            StorageIdentityRef::Session(value) => value.as_str().to_owned(),
        };
        let root =
            path(field(self.root(), "stateRoot"))?.join(&PosixPath::from_scalar_text(&suffix));
        let scratch =
            path(field(self.root(), "scratchRoot"))?.join(&PosixPath::from_scalar_text(&suffix));
        Ok(StoragePathText {
            home: root.join(&PosixPath::from_scalar_text("home")),
            nix: root.join(&PosixPath::from_scalar_text("nix")),
            scratch,
        })
    }
}
pub struct ControlPaths {
    root: PosixPath,
    binding: ControlBindingPaths,
}
pub struct ControlBindingPaths {
    binding: PosixPath,
    pending: PosixPath,
}
pub enum StorageIdentityRef<'a> {
    Employee(&'a ProfileEmployeeId),
    Session(&'a ProfileSessionId),
}
impl ControlPaths {
    pub fn root(&self) -> &PosixPath {
        &self.root
    }
    pub fn binding(&self) -> &PosixPath {
        self.binding.binding()
    }
    pub fn pending(&self) -> &PosixPath {
        self.binding.pending()
    }
}
impl ControlBindingPaths {
    pub fn binding(&self) -> &PosixPath {
        &self.binding
    }
    pub fn pending(&self) -> &PosixPath {
        &self.pending
    }
}
pub struct StoragePathText {
    home: PosixPath,
    nix: PosixPath,
    scratch: PosixPath,
}
impl StoragePathText {
    pub fn home(&self) -> &PosixPath {
        &self.home
    }
    pub fn nix(&self) -> &PosixPath {
        &self.nix
    }
    pub fn scratch(&self) -> &PosixPath {
        &self.scratch
    }
}
#[derive(Clone)]
pub struct ObservedMemoryPolicy {
    memory: UnsignedInteger,
    swap: UnsignedInteger,
    high: Option<UnsignedInteger>,
    pool: bool,
}
impl ObservedMemoryPolicy {
    /// Read the actual existing projection, not a new policy validator. The
    /// application must obtain it via its real effective-config resolver.
    pub fn from_effective(config: &EffectiveWorkerConfig) -> Result<Option<Self>> {
        let root = object(config.as_value())?;
        let Some(value) = field(root, "laptopMemoryPolicy") else {
            return Ok(None);
        };
        let policy = object(value)?;
        Ok(Some(Self {
            pool: matches!(field(root, "budgetMode"), Some(Value(Node::String(mode))) if mode.equals_ascii("pool")),
            memory: unsigned(field(root, "memoryMiB"))?.times(1_048_576),
            swap: unsigned(field(policy, "swapMiB"))?.times(1_048_576),
            high: field(policy, "memoryHighMiB")
                .map(|value| unsigned(Some(value)).map(|value| value.times(1_048_576)))
                .transpose()?,
        }))
    }
    pub fn memory(&self) -> &UnsignedInteger {
        &self.memory
    }
    pub fn swap(&self) -> &UnsignedInteger {
        &self.swap
    }
    pub fn high(&self) -> Option<&UnsignedInteger> {
        self.high.as_ref()
    }
    pub fn uses_pool(&self) -> bool {
        self.pool
    }

    /// Derive current physical expectations for a qualified shared-pool
    /// member. The original projected policy continues to identify creation.
    pub fn with_pool_member_policy(
        mut self,
        settings: crate::worker_pool::WorkerPoolMemberPolicy,
    ) -> Result<Self> {
        let high = UnsignedInteger::from_u64(settings.memory_high_bytes());
        let maximum = u64::from(crate::worker_pool::MEMORY_MAX_MIB) * 1_048_576;
        if !self.pool
            || self.memory.to_u64() != Some(maximum)
            || !self.swap.is_zero()
            || self.high.is_none()
            || high > self.memory
        {
            return Err(EngineDataError::Policy);
        }
        self.high = Some(high);
        Ok(self)
    }
}
fn scalar(value: Option<&Value>) -> Result<String> {
    text(value)
        .and_then(|value| value.0.iter().map(|&point| char::from_u32(point)).collect())
        .ok_or(EngineDataError::Policy)
}
fn path(value: Option<&Value>) -> Result<PosixPath> {
    PosixPath::try_new(&text(value).ok_or(EngineDataError::Policy)?.0)
        .map_err(|_| EngineDataError::Policy)
}
