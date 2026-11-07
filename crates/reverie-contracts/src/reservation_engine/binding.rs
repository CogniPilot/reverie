use super::*;
use reverie_core::posix_path::PosixPath;
/// Exact NativeObserver.limits dictionary DATA, not a held native lease.
pub struct NativeLimitBinding {
    value: Value,
    memory: UnsignedInteger,
    container: ContainerId,
}
impl Clone for NativeLimitBinding {
    fn clone(&self) -> Self {
        Self {
            value: self.value.deep_clone(),
            memory: self.memory.clone(),
            container: self.container.clone(),
        }
    }
}
impl NativeLimitBinding {
    pub fn from_observed_data(
        row: &ContainerRow,
        declared: &DeclaredLimits,
        start: &str,
        group: &PosixPath,
        policy: Option<&ObservedMemoryPolicy>,
    ) -> Result<Self> {
        let mut fields = Object::new();
        let image = row.image()?;
        for (name, value) in [
            ("containerId", row.id().as_str()),
            ("start", start),
            ("image", image.as_str()),
        ] {
            fields.insert(
                key(name),
                Value(Node::String(Text(value.chars().map(u32::from).collect()))),
            );
        }
        fields.insert(key("cgroup"), Value(Node::String(Text(group.codepoints()))));
        for (name, value) in [
            ("pid", declared.pid()),
            ("memory", declared.memory()),
            ("tasks", declared.tasks()),
            ("nanoCpus", declared.cpu()),
        ] {
            fields.insert(key(name), integer_value(value));
        }
        if let Some(policy) = policy {
            fields.insert(key("swapBytes"), integer_value(policy.swap()));
            if let Some(high) = policy.high() {
                fields.insert(key("memoryHighBytes"), integer_value(high));
            }
        }
        Ok(Self {
            value: Value(Node::Object(fields)),
            memory: declared.memory().clone(),
            container: row.id().clone(),
        })
    }
    pub fn memory(&self) -> &UnsignedInteger {
        &self.memory
    }
    pub fn container_id(&self) -> &ContainerId {
        &self.container
    }
    /// Captured relative membership DATA. A native observer still selects its
    /// fixed cgroup root and observes the actual directory; this is no lease.
    pub fn cgroup(&self) -> Result<PosixPath> {
        let fields = object(&self.value)?;
        let value = text(field(fields, "cgroup")).ok_or(EngineDataError::State)?;
        let path = PosixPath::try_new(&value.0).map_err(|_| EngineDataError::State)?;
        if path.is_absolute() || path.has_parent_component() {
            return Err(EngineDataError::State);
        }
        Ok(path)
    }
    pub fn pid(&self) -> Result<UnsignedInteger> {
        unsigned(field(object(&self.value)?, "pid"))
    }
    pub fn start_matches(&self, expected: &str) -> Result<bool> {
        Ok(text(field(object(&self.value)?, "start"))
            .ok_or(EngineDataError::State)?
            .0
            .iter()
            .copied()
            .eq(expected.chars().map(u32::from)))
    }
    pub(crate) fn data(&self) -> &Value {
        &self.value
    }
    pub fn resource_ceiling_matches(
        &self,
        policy: &reverie_core::resources::ResourcePolicy,
    ) -> Result<bool> {
        let fields = object(&self.value)?;
        Ok(
            self.memory == UnsignedInteger::from_u64(u64::from(policy.memory_mib()) * 1_048_576)
                && unsigned(field(fields, "tasks"))?
                    == UnsignedInteger::from_u64(u64::from(policy.pids_limit()))
                && unsigned(field(fields, "nanoCpus"))?
                    == UnsignedInteger::from_u64(policy.cpus().nano_cpus()),
        )
    }
    pub fn canonical_bytes(&self) -> Vec<u8> {
        crate::worker_config::compact_data(&self.value)
    }
}
pub(super) fn integer_value(value: &UnsignedInteger) -> Value {
    Value(Node::Number(Number::Integer(value.as_str().to_owned())))
}
impl StoppedWebsite {
    pub(crate) fn data(&self) -> Value {
        let fields = [
            (
                key("containerId"),
                Value(Node::String(key(self.id().as_str()))),
            ),
            (key("declaredMemory"), integer_value(self.memory())),
            (key("declaredTasks"), integer_value(self.tasks())),
        ]
        .into_iter()
        .collect();
        Value(Node::Object(fields))
    }
    pub fn canonical_bytes(&self) -> Vec<u8> {
        crate::worker_config::compact_data(&self.data())
    }
}
/// Exact NativeObserver.storage dictionary DATA, including all four tuple fields.
pub struct NativeStorageBinding {
    value: Value,
}
impl NativeStorageBinding {
    pub(crate) fn data(&self) -> &Value {
        &self.value
    }
    pub fn from_observed_data(identities: [[u64; 4]; 3]) -> Self {
        let fields = ["/home/agent", "/nix", "/scratch"]
            .into_iter()
            .zip(identities)
            .map(|(name, identity)| {
                (
                    key(name),
                    Value(Node::Array(
                        identity
                            .into_iter()
                            .map(|value| integer_value(&UnsignedInteger::from_u64(value)))
                            .collect(),
                    )),
                )
            })
            .collect();
        Self {
            value: Value(Node::Object(fields)),
        }
    }
    pub fn canonical_bytes(&self) -> Vec<u8> {
        crate::worker_config::compact_data(&self.value)
    }
}
