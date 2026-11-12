//! Purpose-specific fixed NAME inspection. No inventory selection, reservation
//! acceptance, image-equality or controller-policy rules are imported here.
mod security;
use super::*;
use crate::{
    legacy_json,
    worker_config::{EffectiveWorkerConfig, WorkerPolicyDigest},
};
use reverie_core::{decimal::UnsignedInteger, worker_schema::WorkerBase};

pub struct PreflightLaptop(Value);
pub struct PreflightLaptopData(Value);
impl PreflightLaptop {
    pub fn decode(raw: &[u8], base: &WorkerBase, binding: &PreflightBinding) -> Result<Self> {
        let item = Self(legacy_json::decode_loads_bytes(raw).map_err(|_| GpuDataError::Json)?);
        let labels =
            object(required(item.config()?, "Labels")?).ok_or(GpuDataError::NativeBinding)?;
        for (name, expected) in [
            ("reverie.employee", binding.current().identity().as_str()),
            ("reverie.session", binding.current().session().as_str()),
            ("reverie.worker", base.deployment()),
        ] {
            if !required(labels, name)?.python_eq(&string(expected)) {
                return Err(GpuDataError::NativeBinding);
            }
        }
        Ok(item)
    }
    pub fn require_identity(&self, base: &WorkerBase) -> Result<()> {
        let expected = format!("{}:{}", base.ids().uid(), base.ids().gid());
        if !required(self.config()?, "User")?.python_eq(&string(&expected))
            || !matches!(
                field(self.host()?, "ReadonlyRootfs"),
                Some(Value(Node::Bool(true)))
            )
        {
            return Err(GpuDataError::NativeBinding);
        }
        Ok(())
    }
    pub fn require_limits(&self, effective: &EffectiveWorkerConfig) -> Result<()> {
        let resources = object(effective.as_value()).ok_or(GpuDataError::Configuration)?;
        let memory = field(resources, "memoryMiB")
            .and_then(integer)
            .and_then(|value| value.parse::<u64>().ok())
            .and_then(|value| value.checked_mul(1048576))
            .ok_or(GpuDataError::Configuration)?;
        let host = self.host()?;
        if !required(host, "Memory")?.python_eq(&number(memory))
            || !required(host, "MemorySwap")?.python_eq(&number(memory))
            || !required(host, "PidsLimit")?.python_eq(required(resources, "pidsLimit")?)
        {
            return Err(GpuDataError::NativeBinding);
        }
        Ok(())
    }
    pub fn require_policy(&self, policy: &WorkerPolicyDigest) -> Result<()> {
        let labels =
            object(required(self.config()?, "Labels")?).ok_or(GpuDataError::NativeBinding)?;
        if !required(labels, "reverie.worker-policy")?.python_eq(&string(&policy.to_hex())) {
            return Err(GpuDataError::NativeBinding);
        }
        Ok(())
    }
    pub fn process_pid(&self) -> Result<Option<UnsignedInteger>> {
        let state = self.state()?;
        let running = required(state, "Running")?;
        if !legacy_json::truthy(Some(running)) {
            return Ok(None);
        }
        let pid = integer(required(state, "Pid")?)
            .and_then(UnsignedInteger::parse)
            .filter(|pid| pid > &UnsignedInteger::from_u64(1))
            .ok_or(GpuDataError::NativeBinding)?;
        Ok(Some(pid))
    }
    pub fn project(&self, process: Option<&PreflightProcessData>) -> Result<PreflightLaptopData> {
        let pid = self.process_pid()?;
        if pid.as_ref() != process.map(PreflightProcessData::pid) {
            return Err(GpuDataError::NativeBinding);
        }
        let root = self.root()?;
        let host = self.host()?;
        let state = self.state()?;
        let mut value = Object::new();
        for (name, source) in [("id", "Id"), ("image", "Image")] {
            value.insert(key(name), required(root, source)?.deep_clone());
        }
        for (name, source) in [
            ("running", "Running"),
            ("startedAt", "StartedAt"),
            ("oomKilled", "OOMKilled"),
        ] {
            value.insert(key(name), required(state, source)?.deep_clone());
        }
        value.insert(
            key("process"),
            process.map_or(Value(Node::Null), PreflightProcessData::value),
        );
        value.insert(
            key("resources"),
            Value(Node::Object(
                ["Memory", "MemorySwap", "PidsLimit"]
                    .into_iter()
                    .map(|name| (key(name), optional(host, name)))
                    .collect(),
            )),
        );
        for (name, source) in [
            ("devices", "Devices"),
            ("cdiDevices", "CDIDevices"),
            ("deviceRequests", "DeviceRequests"),
            ("capAdd", "CapAdd"),
            ("capDrop", "CapDrop"),
        ] {
            value.insert(key(name), optional(host, source));
        }
        Ok(PreflightLaptopData(Value(Node::Object(value))))
    }
    fn root(&self) -> Result<&Object> {
        object(&self.0).ok_or(GpuDataError::NativeBinding)
    }
    fn config(&self) -> Result<&Object> {
        object(required(self.root()?, "Config")?).ok_or(GpuDataError::NativeBinding)
    }
    fn host(&self) -> Result<&Object> {
        object(required(self.root()?, "HostConfig")?).ok_or(GpuDataError::NativeBinding)
    }
    fn state(&self) -> Result<&Object> {
        object(required(self.root()?, "State")?).ok_or(GpuDataError::NativeBinding)
    }
}
impl PreflightLaptopData {
    pub fn equivalent(&self, other: &Self) -> bool {
        self.value().python_eq(other.value())
    }
    pub fn process_pid(&self) -> Result<Option<UnsignedInteger>> {
        let root = object(&self.0).expect("projected laptop object");
        let process = required(root, "process")?;
        if matches!(process.0, Node::Null) {
            return Ok(None);
        }
        let process = object(process).ok_or(GpuDataError::NativeBinding)?;
        Ok(Some(
            integer(required(process, "pid")?)
                .and_then(UnsignedInteger::parse)
                .ok_or(GpuDataError::NativeBinding)?,
        ))
    }
    pub fn process_matches(&self, process: &PreflightProcessData) -> bool {
        object(&self.0)
            .and_then(|root| field(root, "process"))
            .is_some_and(|value| value.python_eq(&process.value()))
    }
    pub(crate) fn value(&self) -> &Value {
        &self.0
    }
}
fn required<'a>(root: &'a Object, name: &str) -> Result<&'a Value> {
    field(root, name).ok_or(GpuDataError::NativeBinding)
}
fn optional(root: &Object, name: &str) -> Value {
    field(root, name).map_or(Value(Node::Null), Value::deep_clone)
}
