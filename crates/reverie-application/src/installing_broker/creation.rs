//! Complete ordinary Broker.check_creation_budget sequence. Successful reads
//! are DATA, not authorization, storage exclusion or an effect/start permit.
use super::*;
use crate::reservation_gate::OrdinaryLaunchAdmission;
use reverie_contracts::{
    creation_budget::{
        self as data, CreationPeerInspection, CreationPeerName, CreationPeerNames,
        LegacyPoolLimits, PeerProcessId,
    },
    resource_config::checked_effective_policy,
    worker_config::EffectiveWorkerConfig,
};
use reverie_core::{capacity, decimal::UnsignedInteger};
use reverie_host::{
    creation_budget::{CreationHostError, CreationKernel},
    reservation_kernel::ReservationKernel,
    worker_runtime::WorkerRuntime,
};
use std::time::{Duration, Instant};
#[cfg(test)]
mod tests;
#[derive(Debug)]
pub enum CreationBudgetError {
    Data(data::CreationBudgetError),
    Host(CreationHostError),
    Kernel(reverie_host::reservation_kernel::ReservationKernelError),
    Effective(crate::resource_staging::ResourceServiceError),
    Resource(reverie_contracts::broker_resources::ResourceConfigError),
    Memory(reverie_contracts::device_policy::DeviceConfigError),
    Capacity(capacity::CapacityError),
    Configuration(reverie_contracts::reservation_engine::EngineDataError),
    Gate(GateError),
    Controller(reverie_host::worker_pool::PoolError),
    Refused(&'static str),
}
impl CreationBudgetError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Data(error) => error.code(),
            Self::Host(error) => error.code(),
            Self::Kernel(error) => error.code(),
            Self::Resource(error) => error.code(),
            Self::Memory(error) => error.code(),
            Self::Capacity(error) => error.code(),
            Self::Configuration(error) => error.code(),
            Self::Gate(error) => error.code(),
            Self::Controller(error) => error.code(),
            Self::Effective(error) => error.code(),
            Self::Refused(code) => code,
        }
    }
}
impl std::fmt::Display for CreationBudgetError {
    fn fmt(&self, output: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        output.write_str(self.code())
    }
}
impl std::error::Error for CreationBudgetError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Data(error) => Some(error),
            Self::Host(error) => Some(error),
            Self::Kernel(error) => Some(error),
            Self::Effective(error) => Some(error),
            Self::Resource(error) => Some(error),
            Self::Memory(error) => Some(error),
            Self::Capacity(error) => Some(error),
            Self::Configuration(error) => Some(error),
            Self::Gate(error) => Some(error),
            Self::Controller(error) => Some(error),
            Self::Refused(_) => None,
        }
    }
}
macro_rules! conversion {
    ($ty:ty,$variant:ident) => {
        impl From<$ty> for CreationBudgetError {
            fn from(error: $ty) -> Self {
                Self::$variant(error)
            }
        }
    };
}
conversion!(data::CreationBudgetError, Data);
conversion!(CreationHostError, Host);
conversion!(
    reverie_host::reservation_kernel::ReservationKernelError,
    Kernel
);
conversion!(crate::resource_staging::ResourceServiceError, Effective);
conversion!(
    reverie_contracts::broker_resources::ResourceConfigError,
    Resource
);
conversion!(reverie_contracts::device_policy::DeviceConfigError, Memory);
conversion!(capacity::CapacityError, Capacity);
conversion!(
    reverie_contracts::reservation_engine::EngineDataError,
    Configuration
);
conversion!(GateError, Gate);
conversion!(reverie_host::worker_pool::PoolError, Controller);
mod controller;
type Result<T> = std::result::Result<T, CreationBudgetError>;
fn need(value: bool, code: &'static str) -> Result<()> {
    if value {
        Ok(())
    } else {
        Err(CreationBudgetError::Refused(code))
    }
}
trait Source {
    fn names(&self) -> Result<String>;
    fn inspect(
        &self,
        name: &CreationPeerName<'_>,
    ) -> Result<reverie_host::broker_engine::LaptopInspectOutput>;
    fn pooled(&self, pid: &PeerProcessId) -> Result<bool>;
    fn host_root(&self) -> Result<()>;
    fn swap_total(&self) -> Result<UnsignedInteger>;
    fn pool(&self) -> Result<LegacyPoolLimits>;
    fn total(&self) -> Result<Option<UnsignedInteger>>;
}
struct Installed<'a>(&'a WorkerRuntime);
impl Installed<'_> {
    fn end(&self) -> Instant {
        let end = Instant::now() + Duration::from_secs(20);
        self.0.stop_deadline().map_or(end, |stop| end.min(stop))
    }
}
impl Source for Installed<'_> {
    fn names(&self) -> Result<String> {
        Ok(self.0.creation_peer_names(self.end())?)
    }
    fn inspect(
        &self,
        name: &CreationPeerName<'_>,
    ) -> Result<reverie_host::broker_engine::LaptopInspectOutput> {
        Ok(self.0.inspect_creation_peer(name, self.end())?)
    }
    fn pooled(&self, pid: &PeerProcessId) -> Result<bool> {
        Ok(CreationKernel::peer_uses_pool(pid, self.end())?)
    }
    fn host_root(&self) -> Result<()> {
        ReservationKernel::new().host_root(self.end())?;
        Ok(())
    }
    fn swap_total(&self) -> Result<UnsignedInteger> {
        Ok(CreationKernel::swap_total(self.end())?)
    }
    fn pool(&self) -> Result<LegacyPoolLimits> {
        Ok(CreationKernel::legacy_pool(self.end())?)
    }
    fn total(&self) -> Result<Option<UnsignedInteger>> {
        Ok(CreationKernel::legacy_total(self.end())?)
    }
}
impl InstallingBroker {
    /// Original separate pool activation/task-headroom phase. This must run at
    /// the canonical reuse/replacement point, not be inferred from budget reads.
    pub fn check_pool(
        &self,
        resources: &EffectiveWorkerConfig,
        require_headroom: bool,
    ) -> Result<()> {
        self.check_pool_until(
            resources,
            require_headroom,
            Installed(&self.storage.runtime).end(),
        )
    }
    pub(super) fn check_pool_until(
        &self,
        resources: &EffectiveWorkerConfig,
        require_headroom: bool,
        end: Instant,
    ) -> Result<()> {
        let policy = checked_effective_policy(resources)?;
        let source = self.configuration()?;
        let provider =
            reverie_contracts::worker_pool::WorkerPoolProvider::from_config(source.configuration())
                .map_err(|_| CreationBudgetError::Refused("WORKER_POOL_PROVIDER_INVALID"))?;
        if provider.is_some() {
            self.borrow_controller_for_creation()?
                .check_pool(&policy, require_headroom, end)?;
            return Ok(());
        }
        Ok(CreationKernel::check_pool(&policy, require_headroom, end)?)
    }
    /// Called only with the real retained admission and freshly resolved worker
    /// resources at the canonical producer's original pre/post-Nix phases.
    /// No result here registers a laptop or releases any held resource.
    pub fn check_creation_budget(
        &self,
        session: &ProfileSessionId,
        resources: &EffectiveWorkerConfig,
        admission: Option<&OrdinaryLaunchAdmission>,
    ) -> Result<()> {
        let lifecycle = self.installed.lifecycle()?;
        self.check_creation_budget_locked(&lifecycle, session, resources, admission)
    }
    /// The canonical launch already holds this SAME lifecycle across its
    /// pre/post-Nix phases. Borrow it instead of reacquiring a nonreentrant
    /// mutex or opening an unlock/relock gap in the original sequence.
    pub(super) fn check_creation_budget_locked(
        &self,
        lifecycle: &LaptopLifecycle<'_>,
        session: &ProfileSessionId,
        resources: &EffectiveWorkerConfig,
        admission: Option<&OrdinaryLaunchAdmission>,
    ) -> Result<()> {
        self.check_creation_budget_selected_locked(lifecycle, session, resources, admission, None)
    }

    fn check_creation_budget_selected_locked(
        &self,
        lifecycle: &LaptopLifecycle<'_>,
        session: &ProfileSessionId,
        resources: &EffectiveWorkerConfig,
        admission: Option<&OrdinaryLaunchAdmission>,
        member: Option<&mut super::installed_controller::InstalledMemberCreation<'_>>,
    ) -> Result<()> {
        need(
            lifecycle.belongs_to(&self.installed),
            "WORKER_CREATION_LIFECYCLE_ORIGIN",
        )?;
        let snapshot = self.configuration()?;
        let registered = lifecycle
            .entries()
            .map(|(_, name)| name.clone())
            .collect::<Vec<_>>();
        let inputs = Inputs {
            config: snapshot.configuration(),
            resources,
            session,
            deployment: snapshot.envelope().base().deployment(),
            max_workers: usize::from(snapshot.envelope().base().max_workers()),
        };
        check_selected(
            &inputs,
            &registered,
            self.gate.as_ref(),
            admission,
            member,
            &Installed(&self.storage.runtime),
        )
    }
}
struct Inputs<'a> {
    config: &'a EffectiveWorkerConfig,
    resources: &'a EffectiveWorkerConfig,
    session: &'a ProfileSessionId,
    deployment: &'a str,
    max_workers: usize,
}
#[cfg(test)]
fn check(
    inputs: &Inputs<'_>,
    registered: &[WorkerContainerName],
    gate: Option<&ReservationGate>,
    admission: Option<&OrdinaryLaunchAdmission>,
    source: &impl Source,
) -> Result<()> {
    check_selected(inputs, registered, gate, admission, None, source)
}
fn check_selected(
    inputs: &Inputs<'_>,
    registered: &[WorkerContainerName],
    gate: Option<&ReservationGate>,
    admission: Option<&OrdinaryLaunchAdmission>,
    member: Option<&mut super::installed_controller::InstalledMemberCreation<'_>>,
    source: &impl Source,
) -> Result<()> {
    let names = CreationPeerNames::capture(&source.names()?, registered, inputs.deployment);
    let mut has_pool = data::resources_use_pool(inputs.resources)?;
    let (outside, rows) = peers(inputs, &names, &mut has_pool, source)?;
    need(rows.len() < inputs.max_workers, "Worker capacity is full")?;
    let configured = ReservationConfiguration::capture(inputs.config.clone());
    if configured.memory_policies_enabled() {
        swap_budget(&configured, &rows, inputs.resources, source)?;
    }
    if member.is_some() || gate.is_some() || data::has_reservation_option(inputs.config) {
        let (Some(gate), Some(admission)) = (gate, admission) else {
            return Err(CreationBudgetError::Refused(
                "Resource reservation control requires reconciliation",
            ));
        };
        need(
            admission.session() == inputs.session && admission.belongs_to(gate),
            "WORKER_CREATION_ADMISSION_CONTEXT",
        )?;
        match member {
            Some(member) => admission.check_member_creation(member)?,
            None => admission.check_creation(&checked_effective_policy(inputs.resources)?)?,
        };
        return Ok(());
    }
    let outside = if let Some(candidate) = data::admitted_memory(inputs.resources)? {
        let outside = outside.plus(&candidate);
        need(
            outside <= configured.pool_bytes()?,
            "Worker memory admission is full; actual peer ceilings reserve the budget",
        )?;
        outside
    } else {
        outside
    };
    if !has_pool {
        return Ok(());
    }
    let pool = source.pool()?;
    let fits = match source.total()? {
        Some(total) => capacity::legacy_headroom_fits(&pool.memory().plus(&outside), &total)?,
        None => false,
    };
    need(fits, "Pool plus actual peer ceilings exceed host headroom")
}
fn peers(
    inputs: &Inputs<'_>,
    names: &CreationPeerNames,
    has_pool: &mut bool,
    source: &impl Source,
) -> Result<(UnsignedInteger, Vec<CreationPeerInspection>)> {
    let memory_policies =
        ReservationConfiguration::capture(inputs.config.clone()).memory_policies_enabled();
    let mut outside = UnsignedInteger::from_u64(0);
    let mut rows = Vec::new();
    for name in names.names() {
        let session = name.session()?;
        if &session == inputs.session {
            continue;
        }
        let inspected = source.inspect(&name)?;
        if !inspected.succeeded {
            need(
                !name.listed(),
                "Cannot inspect a running peer for resource admission",
            )?;
            continue;
        }
        let row = CreationPeerInspection::decode(&inspected.stdout)?;
        if !row.running_identity(inputs.deployment, &session)? {
            continue;
        }
        rows.push(row);
        let row = rows.last().expect("pushed");
        if source.pooled(&row.process()?)? {
            *has_pool = true;
            continue;
        }
        let declarations = row.outside_declarations()?;
        let effective = memory_policies
            .then(|| crate::resource_staging::effective_config(inputs.config.clone(), &session))
            .transpose()?;
        let swap = effective
            .as_ref()
            .map(reverie_contracts::device_policy::memory::projected_swap_bytes)
            .transpose()?;
        outside = outside.plus(&declarations.assert_memory(swap)?);
    }
    Ok((outside, rows))
}
fn swap_budget(
    config: &ReservationConfiguration,
    rows: &[CreationPeerInspection],
    candidate: &EffectiveWorkerConfig,
    source: &impl Source,
) -> Result<()> {
    source.host_root()?;
    let budget = config.swap_pool_bytes()?;
    let mut committed = UnsignedInteger::from_u64(0);
    for row in rows {
        committed = committed.plus(&row.swap_commitment()?);
    }
    need(
        committed.plus(&UnsignedInteger::from_u64(
            reverie_contracts::device_policy::memory::projected_swap_bytes(candidate)?,
        )) <= budget,
        "Laptop swap admission is full",
    )?;
    if !budget.is_zero() {
        need(
            budget <= source.swap_total()?,
            "Laptop swap pool exceeds actual host swap capacity",
        )?;
    }
    Ok(())
}
