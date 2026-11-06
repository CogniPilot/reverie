//! Broker.check_creation_budget's legacy DATA phases. These differ from the
//! stricter reservation inventory/limits. No value here owns a native process,
//! qualifies a cgroup, authorizes a request, or permits a container start.
mod kernel;
mod peer;
mod pool_check;
use crate::legacy_json::{Node, Text, Value};
pub use kernel::{LegacyPoolLimits, LegacyPoolMemory, creation_peer_uses_pool, legacy_memtotal};
pub use peer::{CreationPeerInspection, OutsidePeerDeclarations, PeerProcessId};
pub use pool_check::check_pool_counters;
use reverie_core::{ids::ProfileSessionId, worker_laptop::WorkerContainerName};
use std::{
    collections::{BTreeMap, BTreeSet},
    fmt,
};
type Object = BTreeMap<Text, Value>;
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CreationBudgetError {
    Name,
    Inspection,
    Json,
    Structure,
    Ownership,
    Pid,
    Cgroup,
    Outside,
    SwapDeclarations,
    Integer,
    Pool,
    MissingTotal,
    ShortTotal,
    PoolActivation,
    TaskHeadroom,
}
impl CreationBudgetError {
    pub fn code(self) -> &'static str {
        match self {
            Self::Name => "Unknown laptop in resource admission",
            Self::Inspection => "Cannot identify a peer for resource admission",
            Self::Json => "WORKER_CREATION_PEER_JSON",
            Self::Structure => "WORKER_CREATION_PEER_STRUCTURE",
            Self::Ownership => "Laptop resource ownership mismatch",
            Self::Pid => "Unknown peer process during resource admission",
            Self::Cgroup => "Unified peer cgroup identity required",
            Self::Outside => "Outside-pool peer requires finite RAM and zero swap",
            Self::SwapDeclarations => "Finite laptop RAM and swap declarations required",
            Self::Integer => "PYTHON_INTEGER_CONVERSION",
            Self::Pool => "Finite positive shared pool limits required",
            Self::MissingTotal => "WORKER_CREATION_MEMTOTAL_MISSING",
            Self::ShortTotal => "WORKER_CREATION_MEMTOTAL_FIELD",
            Self::PoolActivation => {
                "Activate the owner-managed worker slice with its memory and task ceilings before starting isolated agents"
            }
            Self::TaskHeadroom => "Worker pool has insufficient task headroom",
        }
    }
}
impl fmt::Display for CreationBudgetError {
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        output.write_str(self.code())
    }
}
impl std::error::Error for CreationBudgetError {}
type Result<T> = std::result::Result<T, CreationBudgetError>;
fn key(text: &str) -> Text {
    Text(text.chars().map(u32::from).collect())
}
fn object(value: &Value) -> Result<&Object> {
    match &value.0 {
        Node::Object(value) => Ok(value),
        _ => Err(CreationBudgetError::Structure),
    }
}
fn field<'a>(value: &'a Value, name: &str) -> Result<&'a Value> {
    object(value)?
        .get(&key(name))
        .ok_or(CreationBudgetError::Structure)
}
fn unsigned(value: &Value) -> Option<reverie_core::decimal::UnsignedInteger> {
    match &value.0 {
        Node::Number(crate::legacy_json::Number::Integer(text)) => {
            reverie_core::decimal::UnsignedInteger::parse(text)
        }
        _ => None,
    }
}
pub fn resources_use_pool(resources: &crate::worker_config::EffectiveWorkerConfig) -> Result<bool> {
    Ok(
        matches!(&field(resources.as_value(),"budgetMode")?.0, Node::String(value) if value.equals_ascii("pool")),
    )
}
pub fn admitted_memory(
    resources: &crate::worker_config::EffectiveWorkerConfig,
) -> Result<Option<reverie_core::decimal::UnsignedInteger>> {
    let admission = matches!(&field(resources.as_value(),"budgetMode")?.0, Node::String(value) if value.equals_ascii("admission"));
    if !admission {
        return Ok(None);
    }
    Ok(Some(
        unsigned(field(resources.as_value(), "memoryMiB")?)
            .ok_or(CreationBudgetError::Structure)?
            .times(1_048_576),
    ))
}
pub fn has_reservation_option(source: &crate::worker_config::EffectiveWorkerConfig) -> bool {
    object(source.as_value())
        .expect("worker object")
        .contains_key(&key("resourceReservations"))
}
/// The source iterates a Python set; ordering between different names was never
/// stable. Keep uniqueness and per-name native phases, using a deterministic
/// order here rather than prevalidating all names before any peer inspection.
pub struct CreationPeerNames {
    deployment: String,
    names: BTreeSet<String>,
    listed: BTreeSet<String>,
}
pub struct CreationPeerName<'a> {
    deployment: &'a str,
    name: &'a str,
    listed: bool,
}
impl CreationPeerNames {
    pub fn capture<'a>(
        stdout: &str,
        registry: impl IntoIterator<Item = &'a WorkerContainerName>,
        deployment: &str,
    ) -> Self {
        let listed = crate::kernel_accounting::lines(stdout)
            .into_iter()
            .map(str::to_owned)
            .collect::<BTreeSet<_>>();
        let mut names = listed.clone();
        names.extend(registry.into_iter().map(|name| name.as_str().to_owned()));
        Self {
            deployment: deployment.into(),
            names,
            listed,
        }
    }
    pub fn names(&self) -> impl Iterator<Item = CreationPeerName<'_>> {
        self.names.iter().map(|name| CreationPeerName {
            deployment: &self.deployment,
            name,
            listed: self.listed.contains(name),
        })
    }
}
impl CreationPeerName<'_> {
    pub fn name(&self) -> &str {
        self.name
    }
    pub fn deployment(&self) -> &str {
        self.deployment
    }
    pub fn listed(&self) -> bool {
        self.listed
    }
    pub fn session(&self) -> Result<ProfileSessionId> {
        let prefix = format!("{}-agent-", self.deployment);
        ProfileSessionId::parse(self.name.strip_prefix(&prefix).unwrap_or(self.name))
            .map_err(|_| CreationBudgetError::Name)
    }
}
