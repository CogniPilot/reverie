use super::*;
use crate::legacy_json::Number;
use reverie_core::decimal::UnsignedInteger;
/// Checked fixed host-job declarations only. Native paths/artifacts, current
/// systemd/kernel facts and executing-owner permission remain separate.
pub struct HostJobSpecData {
    job: HostJobId,
    limits: HostScopeLimits,
    policy: JournalDigest,
    hashes: [JournalDigest; 3],
    paths: [Value; 4],
}
#[derive(Clone, Copy)]
pub enum HostJobPath {
    Systemctl,
    NodeExecutable,
    NodeEntry,
    WorkingDirectory,
}
impl HostJobPath {
    pub const ORDER: [Self; 4] = [
        Self::Systemctl,
        Self::NodeExecutable,
        Self::NodeEntry,
        Self::WorkingDirectory,
    ];
    fn index(self) -> usize {
        match self {
            Self::Systemctl => 0,
            Self::NodeExecutable => 1,
            Self::NodeEntry => 2,
            Self::WorkingDirectory => 3,
        }
    }
}
impl HostJobSpecData {
    pub(super) fn capture(fields: &Object) -> Result<Self> {
        // require_idle converts tuple(spec['cpus']) before calling the
        // dataclass constructor. Only noniterables fail at this early phase.
        if !matches!(
            field(fields, "cpus")?.0,
            Node::Array(_) | Node::Object(_) | Node::String(_)
        ) {
            return Err(HostJobDataError::Spec);
        }
        exact(
            fields,
            &[
                "job_id",
                "purpose",
                "policy_digest",
                "unit",
                "memory_bytes",
                "pids",
                "cpus",
                "runtime_seconds",
                "stop_seconds",
                "systemctl",
                "systemctl_sha256",
                "node_exe",
                "node_sha256",
                "node_entry",
                "node_entry_sha256",
                "working_directory",
            ],
            HostJobDataError::Spec,
        )?;
        let job = HostJobId::parse(
            &scalar(field(fields, "job_id")?).map_err(|_| HostScopeError::JobId)?,
        )?;
        if !equals(field(fields, "purpose")?, "fixed-public-browser")
            || !equals(field(fields, "unit")?, &job.unit())
        {
            return Err(HostJobDataError::FixedScope);
        }
        let policy = hash(
            field(fields, "policy_digest")?,
            HostJobDataError::PolicyDigest,
        )?;
        let memory = integer(field(fields, "memory_bytes")?)?;
        let pids = u32::try_from(integer(field(fields, "pids")?)?)
            .map_err(|_| HostScopeError::FiniteSpec)?;
        let runtime = u32::try_from(integer(field(fields, "runtime_seconds")?)?)
            .map_err(|_| HostScopeError::FiniteSpec)?;
        let stop = u32::try_from(integer(field(fields, "stop_seconds")?)?)
            .map_err(|_| HostScopeError::FiniteSpec)?;
        HostScopeLimits::validate_counters(memory, pids, runtime, stop)?;
        let cpus = cpus(field(fields, "cpus")?)?;
        let limits = HostScopeLimits::try_new(memory, pids, runtime, stop, cpus)?;
        let hashes = [
            hash(
                field(fields, "systemctl_sha256")?,
                HostJobDataError::SourceDigest,
            )?,
            hash(
                field(fields, "node_sha256")?,
                HostJobDataError::SourceDigest,
            )?,
            hash(
                field(fields, "node_entry_sha256")?,
                HostJobDataError::SourceDigest,
            )?,
        ];
        let paths = [
            field(fields, "systemctl")?.deep_clone(),
            field(fields, "node_exe")?.deep_clone(),
            field(fields, "node_entry")?.deep_clone(),
            field(fields, "working_directory")?.deep_clone(),
        ];
        Ok(Self {
            job,
            limits,
            policy,
            hashes,
            paths,
        })
    }
    pub fn job_id(&self) -> &HostJobId {
        &self.job
    }
    pub fn limits(&self) -> &HostScopeLimits {
        &self.limits
    }
    pub fn policy_digest(&self) -> &JournalDigest {
        &self.policy
    }
    pub fn source_hashes(&self) -> [&JournalDigest; 3] {
        self.hashes.each_ref()
    }
    /// Capture each declaration only immediately before its real path resolve,
    /// so a later malformed declaration cannot mask an earlier native failure.
    pub fn path(&self, selected: HostJobPath) -> Result<MetadataText> {
        path(&self.paths[selected.index()])
    }
}
fn scalar(value: &Value) -> Result<String> {
    match &value.0 {
        Node::String(text) => text
            .0
            .iter()
            .copied()
            .map(char::from_u32)
            .collect::<Option<String>>()
            .ok_or(HostJobDataError::Spec),
        _ => Err(HostJobDataError::Spec),
    }
}
fn hash(value: &Value, error: HostJobDataError) -> Result<JournalDigest> {
    JournalDigest::parse(&scalar(value).map_err(|_| error)?).map_err(|_| error)
}
fn path(value: &Value) -> Result<MetadataText> {
    match &value.0 {
        Node::String(text) => Ok(MetadataText::from_text(text.clone())),
        _ => Err(HostJobDataError::Spec),
    }
}
fn integer(value: &Value) -> Result<u64> {
    match &value.0 {
        Node::Number(Number::Integer(value)) => {
            value.parse().map_err(|_| HostScopeError::FiniteSpec.into())
        }
        _ => Err(HostScopeError::FiniteSpec.into()),
    }
}
fn cpus(value: &Value) -> Result<Vec<UnsignedInteger>> {
    let Node::Array(values) = &value.0 else {
        return Err(HostScopeError::CpuSpec.into());
    };
    if !(1..=8).contains(&values.len()) {
        return Err(HostScopeError::CpuSpec.into());
    }
    values
        .iter()
        .map(|value| match &value.0 {
            Node::Number(Number::Integer(value)) => {
                UnsignedInteger::parse(value).ok_or_else(|| HostScopeError::CpuSpec.into())
            }
            _ => Err(HostScopeError::CpuSpec.into()),
        })
        .collect()
}
