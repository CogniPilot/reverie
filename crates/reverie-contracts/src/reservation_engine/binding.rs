use super::*;
use reverie_core::posix_path::PosixPath;
/// Exact NativeObserver.limits dictionary DATA, not a held native lease.
pub struct NativeLimitBinding {
    value: Value,
    memory: UnsignedInteger,
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
        })
    }
    pub fn memory(&self) -> &UnsignedInteger {
        &self.memory
    }
    pub fn canonical_bytes(&self) -> Vec<u8> {
        crate::worker_config::compact_data(&self.value)
    }
}
pub(super) fn integer_value(value: &UnsignedInteger) -> Value {
    Value(Node::Number(Number::Integer(value.as_str().to_owned())))
}
impl StoppedWebsite {
    pub fn canonical_bytes(&self) -> Vec<u8> {
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
        crate::worker_config::compact_data(&Value(Node::Object(fields)))
    }
}
/// Exact NativeObserver.storage dictionary DATA, including all four tuple fields.
pub struct NativeStorageBinding {
    value: Value,
}
impl NativeStorageBinding {
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
