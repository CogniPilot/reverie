use super::{Result, TaskPerfError, bounded_json, key, object, string};
use crate::legacy_json::{Node, Number};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PerfSystem {
    X86_64Linux,
    Aarch64Linux,
}
impl PerfSystem {
    pub fn from_linux_uname(system: &str, machine: &str) -> Result<Self> {
        match (system, machine) {
            ("Linux", "x86_64") => Ok(Self::X86_64Linux),
            ("Linux", "aarch64") => Ok(Self::Aarch64Linux),
            _ => Err(TaskPerfError::System),
        }
    }
    pub fn name(self) -> &'static str {
        match self {
            Self::X86_64Linux => "x86_64-linux",
            Self::Aarch64Linux => "aarch64-linux",
        }
    }
}

/// One closed manifest decoded from the installed package's fixed location.
/// Paths/hashes identify artifact bytes; this value confers no filesystem trust.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TaskPerfManifest {
    system: PerfSystem,
    base_profile: String,
    base_sha256: String,
    profile: String,
    profile_sha256: String,
}
impl TaskPerfManifest {
    pub fn decode(raw: &[u8], observed_system: PerfSystem) -> Result<Self> {
        let value = bounded_json(raw)?;
        let fields = object(&value).ok_or(TaskPerfError::Manifest)?;
        let expected = [
            "version",
            "purpose",
            "system",
            "baseProfile",
            "baseSHA256",
            "profile",
            "profileSHA256",
        ];
        if fields.len() != expected.len()
            || !expected.iter().all(|name| fields.contains_key(&key(name)))
        {
            return Err(TaskPerfError::Manifest);
        }
        if !matches!(&fields[&key("version")].0, Node::Number(Number::Integer(version)) if version=="1")
            || string(&fields[&key("purpose")]).as_deref() != Some("worker-task-perf-profile-v1")
            || string(&fields[&key("system")]).as_deref() != Some(observed_system.name())
        {
            return Err(TaskPerfError::Manifest);
        }
        let text = |name| string(&fields[&key(name)]).ok_or(TaskPerfError::Manifest);
        let result = Self {
            system: observed_system,
            base_profile: text("baseProfile")?,
            base_sha256: text("baseSHA256")?,
            profile: text("profile")?,
            profile_sha256: text("profileSHA256")?,
        };
        for path in [&result.base_profile, &result.profile] {
            nix_path(path)?;
        }
        for digest in [&result.base_sha256, &result.profile_sha256] {
            sha256(digest)?;
        }
        Ok(result)
    }
    pub fn system(&self) -> PerfSystem {
        self.system
    }
    pub fn base_profile(&self) -> &str {
        &self.base_profile
    }
    pub fn base_sha256(&self) -> &str {
        &self.base_sha256
    }
    pub fn profile(&self) -> &str {
        &self.profile
    }
    pub fn profile_sha256(&self) -> &str {
        &self.profile_sha256
    }
}
pub(super) fn nix_path(path: &str) -> Result<()> {
    // pathlib.Path normalizes separators and '.' before _read checks its Nix
    // prefix; retain the declared spelling for exact rootless config binding.
    let leading = path.bytes().take_while(|&byte| byte == b'/').count();
    let parts: Vec<_> = path
        .split('/')
        .filter(|part| !part.is_empty() && *part != ".")
        .collect();
    if leading == 0
        || leading == 2
        || path.contains('\0')
        || parts.len() < 3
        || parts[..2] != ["nix", "store"]
        || parts.contains(&"..")
    {
        return Err(TaskPerfError::Path);
    }
    Ok(())
}
fn sha256(value: &str) -> Result<()> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(TaskPerfError::Digest);
    }
    Ok(())
}
