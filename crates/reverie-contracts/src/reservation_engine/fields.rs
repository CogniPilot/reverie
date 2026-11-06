use super::*;
use reverie_core::ids::ProfileSessionId;
use std::num::NonZeroU32;
/// Borrowed declarations DATA for the shared native limits reader. It does not
/// validate or invent a CID; complete inventory keeps its separate strict ID.
pub struct NativeLimitFields<'a> {
    value: &'a Value,
}
impl<'a> NativeLimitFields<'a> {
    pub(crate) fn from_data(value: &'a Value) -> Result<Self> {
        object(value).map_err(|_| EngineDataError::Structure)?;
        Ok(Self { value })
    }
    fn root(&self) -> &'a Object {
        object(self.value).expect("validated native field object")
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

    pub(super) fn state(&self) -> Result<&'a Object> {
        let state = field(self.root(), "State").ok_or(EngineDataError::State)?;
        structure_object(Some(state))
    }

    pub(super) fn labels(&self) -> Result<&'a Object> {
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
