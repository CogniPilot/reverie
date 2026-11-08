//! Strict stopped Docker declarations DATA, never a live PID/cgroup observation
//! or proof that orphan resources, writers or a parent scope have settled.
use super::*;
use reverie_core::{operations::MIB, resources::ResourcePolicy};
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StoppedRamDeclaration {
    id: ContainerId,
    image: String,
    memory: UnsignedInteger,
    swap: UnsignedInteger,
    tasks: UnsignedInteger,
    cpu: UnsignedInteger,
}
impl StoppedRamDeclaration {
    pub fn container_id(&self) -> &ContainerId {
        &self.id
    }
    pub fn image(&self) -> &str {
        &self.image
    }
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
    pub fn canonical_bytes(&self) -> Vec<u8> {
        let number =
            |value: &UnsignedInteger| Value(Node::Number(Number::Integer(value.as_str().into())));
        let value = Value(Node::Object(BTreeMap::from([
            (
                key("containerId"),
                Value(Node::String(key(self.id.as_str()))),
            ),
            (key("image"), Value(Node::String(key(&self.image)))),
            (key("memory"), number(&self.memory)),
            (key("swap"), number(&self.swap)),
            (key("tasks"), number(&self.tasks)),
            (key("cpu"), number(&self.cpu)),
        ])));
        crate::worker_config::compact_data(&value)
    }
}
impl ContainerRow {
    /// All full-census rows need real canonical names before absence can be
    /// inferred. Missing/ill-typed names are not nonmatches.
    pub fn stopped_ram_name(&self) -> Result<String> {
        let name = text(field(self.root(), "Name"))
            .and_then(|value| {
                value
                    .0
                    .iter()
                    .copied()
                    .map(char::from_u32)
                    .collect::<Option<String>>()
            })
            .ok_or(EngineDataError::Inventory)?;
        let raw = name.as_bytes();
        if raw.len() < 2
            || raw[0] != b'/'
            || !raw[1].is_ascii_alphanumeric()
            || !raw[1..]
                .iter()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-'))
        {
            return Err(EngineDataError::Inventory);
        }
        Ok(name)
    }
    /// Callers must independently establish this is the same actual selected
    /// native row, current storage, full stopped state and effective policy.
    pub fn stopped_ram_declaration(
        &self,
        expected: &ResourcePolicy,
        policy: Option<&ObservedMemoryPolicy>,
    ) -> Result<StoppedRamDeclaration> {
        StoppedState::validate_ordinary(self)?;
        let host = object(field(self.root(), "HostConfig").ok_or(EngineDataError::FiniteLimits)?)?;
        let memory = unsigned(field(host, "Memory"))?;
        let swap = unsigned(field(host, "MemorySwap"))?;
        let tasks = unsigned(field(host, "PidsLimit"))?;
        let cpu = unsigned(field(host, "NanoCpus"))?;
        let allowance = policy.map_or_else(
            || UnsignedInteger::from_u64(0),
            |value| value.swap().clone(),
        );
        if memory < UnsignedInteger::from_u64(512 * MIB)
            || memory != UnsignedInteger::from_u64(u64::from(expected.memory_mib()) * MIB)
            || swap != memory.plus(&allowance)
            || tasks != UnsignedInteger::from_u64(u64::from(expected.pids_limit()))
            || cpu != UnsignedInteger::from_u64(expected.cpus().nano_cpus())
            || policy.is_some_and(|value| {
                value.memory() != &memory
                    || value
                        .high()
                        .is_some_and(|high| high.is_zero() || high >= &memory)
            })
        {
            return Err(EngineDataError::FiniteLimits);
        }
        Ok(StoppedRamDeclaration {
            id: self.id.clone(),
            image: self.image()?,
            memory,
            swap,
            tasks,
            cpu,
        })
    }
}
