use super::*;
use reverie_core::ids::ProfileSessionId;
use std::num::NonZeroU32;
pub struct ContainerRow {
    pub(super) id: ContainerId,
    pub(super) value: Value,
}
impl Clone for ContainerRow {
    fn clone(&self) -> Self {
        Self {
            id: self.id.clone(),
            value: self.value.deep_clone(),
        }
    }
}
impl ContainerRow {
    pub(super) fn capture(value: Value) -> Result<Self> {
        let id = text(field(
            object(&value).map_err(|_| EngineDataError::Inventory)?,
            "Id",
        ))
        .and_then(|value| {
            value
                .0
                .iter()
                .map(|&c| char::from_u32(c))
                .collect::<Option<String>>()
        })
        .ok_or(EngineDataError::Inventory)?;
        let id = ContainerId::parse(&id).map_err(|_| EngineDataError::Inventory)?;
        Ok(Self { id, value })
    }
    pub fn id(&self) -> &ContainerId {
        &self.id
    }
    pub(crate) fn data(&self) -> &Value {
        &self.value
    }
    pub fn name_is(&self, name: &str) -> bool {
        text(field(self.root(), "Name"))
            .is_some_and(|value| value.0.iter().copied().eq(name.chars().map(u32::from)))
    }
    pub fn snapshot_digest(&self) -> Result<InventoryDigest> {
        digest(&self.value)
    }
    pub fn mounts_digest(&self) -> Result<InventoryDigest> {
        digest(field(self.root(), "Mounts").ok_or(EngineDataError::Mounts)?)
    }
    pub fn running(&self) -> Result<bool> {
        match field(self.state()?, "Running") {
            Some(Value(Node::Bool(value))) => Ok(*value),
            _ => Err(EngineDataError::State),
        }
    }
    pub fn pid(&self) -> Result<UnsignedInteger> {
        unsigned(field(self.state()?, "Pid"))
    }
    pub fn running_header(&self) -> Result<()> {
        // limits() indexes both top-level fields before checking Running.
        // capacity's separate running() projection permits a missing State,
        // so these required accesses must not be moved into that projection.
        let state = required(field(self.root(), "State"))?;
        let host = required(field(self.root(), "HostConfig"))?;
        if !matches!(
            required(field(structure_object(Some(state))?, "Running"))?,
            Value(Node::Bool(true))
        ) {
            return Err(EngineDataError::NotRunning);
        }
        let host = structure_object(Some(host))?;
        if !["Memory", "MemorySwap", "PidsLimit", "NanoCpus"]
            .iter()
            .all(|name| field(host, name).is_some())
        {
            return Err(EngineDataError::Structure);
        }
        self.labels().map_err(|_| EngineDataError::Structure)?;
        Ok(())
    }
    pub fn memory_matches(&self, expected: &UnsignedInteger) -> Result<bool> {
        let host = object(field(self.root(), "HostConfig").ok_or(EngineDataError::FiniteLimits)?)?;
        Ok(field(host, "Memory").is_some_and(|value| {
            value.python_eq(&Value(Node::Number(Number::Integer(
                expected.as_str().to_owned(),
            ))))
        }))
    }
    pub fn worker(&self) -> Result<bool> {
        let labels = self.labels()?;
        Ok(["reverie.worker", "reverie.nix-prepare"]
            .iter()
            .any(|name| field(labels, name).is_some()))
    }
    pub fn label_is(&self, name: &str, value: &str) -> Result<bool> {
        Ok(text(field(self.labels()?, name))
            .is_some_and(|text| text.0.iter().copied().eq(value.chars().map(u32::from))))
    }
    pub fn memory_session(&self, deployment: &str) -> Result<Option<ProfileSessionId>> {
        if !self.label_is("reverie.worker", deployment)? {
            return Ok(None);
        }
        let Some(value) = text(field(self.labels()?, "reverie.session")) else {
            return Ok(None);
        };
        let Some(value) = value
            .0
            .iter()
            .map(|&c| char::from_u32(c))
            .collect::<Option<String>>()
        else {
            return Ok(None);
        };
        Ok(ProfileSessionId::parse(&value).ok())
    }
    pub fn declarations(&self, swap_allowance: &UnsignedInteger) -> Result<DeclaredLimits> {
        self.running_header()?;
        let host = object(field(self.root(), "HostConfig").ok_or(EngineDataError::FiniteLimits)?)?;
        let memory = unsigned(field(host, "Memory"))?;
        let swap = unsigned(field(host, "MemorySwap"))?;
        let tasks = unsigned(field(host, "PidsLimit"))?;
        let cpu = unsigned(field(host, "NanoCpus"))?;
        if memory < UnsignedInteger::from_u64(512 * 1_048_576)
            || memory.remainder(NonZeroU32::new(1_048_576).expect("MiB")) != 0
            || swap != memory.plus(swap_allowance)
            || tasks.is_zero()
        {
            return Err(EngineDataError::FiniteLimits);
        }
        let pid = unsigned(Some(required(field(self.state()?, "Pid"))?))
            .map_err(|_| EngineDataError::Pid)?;
        if pid.is_zero() {
            return Err(EngineDataError::Pid);
        }
        Ok(DeclaredLimits {
            memory,
            swap,
            tasks,
            cpu,
            pid,
        })
    }
    /// Source validates image syntax only after first reading the PID start.
    pub fn image(&self) -> Result<String> {
        let image = text(field(self.root(), "Image"))
            .and_then(|value| {
                value
                    .0
                    .iter()
                    .map(|&c| char::from_u32(c))
                    .collect::<Option<String>>()
            })
            .ok_or(EngineDataError::Image)?;
        if image.len() != 71
            || !image.starts_with("sha256:")
            || !image.as_bytes()[7..]
                .iter()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(b))
        {
            return Err(EngineDataError::Image);
        }
        Ok(image)
    }
    pub fn swap_commitment(&self) -> Result<UnsignedInteger> {
        let host = object(field(self.root(), "HostConfig").ok_or(EngineDataError::FiniteLimits)?)?;
        let memory = unsigned(field(host, "Memory"))?;
        let total = unsigned(field(host, "MemorySwap"))?;
        if memory.is_zero() || total < memory {
            return Err(EngineDataError::FiniteLimits);
        }
        total.minus(&memory).ok_or(EngineDataError::FiniteLimits)
    }
    pub fn mount_sources(&self) -> Result<Vec<MetadataText>> {
        let mut result = Vec::new();
        for mount in self.mounts()? {
            let fields = object(mount).map_err(|_| EngineDataError::Mounts)?;
            let source = field(fields, "Source");
            if text(field(fields, "Type")).is_some_and(|v| v.equals_ascii("tmpfs"))
                && matches!(source, None | Some(Value(Node::Null)))
            {
                continue;
            }
            if text(field(fields, "Type")).is_some_and(|v| v.equals_ascii("tmpfs"))
                && text(source).is_some_and(|v| v.0.is_empty())
            {
                continue;
            }
            let value = text(source).ok_or(EngineDataError::Mounts)?;
            if value.0.first() != Some(&47) {
                return Err(EngineDataError::Mounts);
            }
            result.push(MetadataText::from_text(value.clone()));
        }
        Ok(result)
    }
    pub fn storage_mount_matches(&self, destination: &str, source: &[u32]) -> Result<bool> {
        let selected = self
            .mounts()?
            .iter()
            .filter_map(|value| object(value).ok())
            .filter(|mount| {
                text(field(mount, "Destination"))
                    .is_some_and(|value| value.equals_ascii(destination))
            })
            .collect::<Vec<_>>();
        Ok(selected.len() == 1
            && text(field(selected[0], "Type")).is_some_and(|value| value.equals_ascii("bind"))
            && matches!(field(selected[0], "RW"), Some(Value(Node::Bool(true))))
            && text(field(selected[0], "Source")).is_some_and(|value| value.0 == source))
    }
    pub(super) fn root(&self) -> &Object {
        object(&self.value).expect("captured row object")
    }
    pub(super) fn state(&self) -> Result<&Object> {
        let state = field(self.root(), "State").ok_or(EngineDataError::State)?;
        structure_object(Some(state))
    }
    pub(crate) fn mounts(&self) -> Result<&[Value]> {
        match field(self.root(), "Mounts") {
            Some(Value(Node::Array(values))) => Ok(values),
            _ => Err(EngineDataError::Mounts),
        }
    }
    fn labels(&self) -> Result<&Object> {
        static EMPTY: std::sync::OnceLock<Object> = std::sync::OnceLock::new();
        let config = match field(self.root(), "Config") {
            None => EMPTY.get_or_init(Object::new),
            Some(value) => structure_object(Some(value))?,
        };
        match field(config, "Labels") {
            value if !legacy_json::truthy(value) => Ok(EMPTY.get_or_init(Object::new)),
            Some(value) => object(value),
            None => Ok(EMPTY.get_or_init(Object::new)),
        }
    }
}
fn required(value: Option<&Value>) -> Result<&Value> {
    value.ok_or(EngineDataError::Structure)
}
fn structure_object(value: Option<&Value>) -> Result<&Object> {
    object(required(value)?).map_err(|_| EngineDataError::Structure)
}
pub struct DeclaredLimits {
    memory: UnsignedInteger,
    swap: UnsignedInteger,
    tasks: UnsignedInteger,
    cpu: UnsignedInteger,
    pid: UnsignedInteger,
}
impl DeclaredLimits {
    pub fn memory(&self) -> &UnsignedInteger {
        &self.memory
    }
    pub fn swap(&self) -> &UnsignedInteger {
        &self.swap
    }
    pub fn tasks(&self) -> &UnsignedInteger {
        &self.tasks
    }
    pub fn cpu(&self) -> &UnsignedInteger {
        &self.cpu
    }
    pub fn pid(&self) -> &UnsignedInteger {
        &self.pid
    }
}
pub struct StoppedWebsite {
    memory: UnsignedInteger,
    tasks: UnsignedInteger,
    id: ContainerId,
}
impl StoppedWebsite {
    pub fn memory(&self) -> &UnsignedInteger {
        &self.memory
    }
    pub fn tasks(&self) -> &UnsignedInteger {
        &self.tasks
    }
    pub fn id(&self) -> &ContainerId {
        &self.id
    }
}
impl ContainerRow {
    pub fn stopped_website(&self, id: &ContainerId) -> Result<StoppedWebsite> {
        self.stopped_website_header(id)
            .map_err(|_| EngineDataError::StoppedWebsiteRequired)?;
        self.stopped_website_declarations()
            .map_err(|_| EngineDataError::StoppedWebsiteLimits)
    }
    fn stopped_website_header(&self, id: &ContainerId) -> Result<()> {
        let state = self.state()?;
        if &self.id != id
            || self.running()?
            || !self.pid()?.is_zero()
            || legacy_json::truthy(field(state, "Paused"))
            || legacy_json::truthy(field(state, "Restarting"))
            || self.worker()?
        {
            return Err(EngineDataError::StoppedWebsiteRequired);
        }
        Ok(())
    }
    fn stopped_website_declarations(&self) -> Result<StoppedWebsite> {
        let host = object(field(self.root(), "HostConfig").ok_or(EngineDataError::FiniteLimits)?)?;
        let memory = unsigned(field(host, "Memory"))?;
        let swap = unsigned(field(host, "MemorySwap"))?;
        let tasks = unsigned(field(host, "PidsLimit"))?;
        if memory.is_zero()
            || memory != swap
            || tasks.is_zero()
            || tasks > UnsignedInteger::from_u64(32768)
        {
            return Err(EngineDataError::FiniteLimits);
        }
        Ok(StoppedWebsite {
            memory,
            tasks,
            id: self.id.clone(),
        })
    }
}
