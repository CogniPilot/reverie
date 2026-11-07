//! Named ordinary cold phases over the SAME checked registry workflow.
//! No mutable resource, workflow or Runtime is extracted for the handler.
use super::*;
use reverie_contracts::worker_config::{EffectiveWorkerConfig, WorkerPolicyDigest};
use reverie_host::{
    command_telemetry::CommandTelemetry,
    worker_laptop::{
        ColdCommit, ColdCommitted, ColdPreparation, ConfiguredMemory, ContainerStart,
        CreatedLaptop, LaptopCreation, MemoryConfiguration, NixGuardRelease, PaneStart,
        StartedContainer, StartedMemoryPolicy, StartedMemoryReadback, StartedPane,
        WorkerMemoryBegin, WorkerMemoryEffect,
    },
    worker_reports::WorkerLaunchConnection,
    worker_runtime::WorkerRuntime,
};
type Result<T> = std::result::Result<T, NetworkStorageError>;
impl NetworkStoragePreparation {
    pub(in crate::installing_broker) fn phase_failure(&self) -> Result<Option<Arc<LaptopError>>> {
        self.workflow.failure().map_err(NetworkStorageError::Host)
    }
    fn cold_runtime(&self) -> Result<&WorkerRuntime> {
        self.check()?;
        Ok(&self.destination.registry().runtime)
    }
    pub(in crate::installing_broker) fn run_for_connection(
        &self,
        connection: &WorkerLaunchConnection,
    ) -> Result<LaptopNetworkProgress> {
        self.cold_runtime()?
            .run_laptop_network_for_connection(&self.workflow, connection)
            .map_err(NetworkStorageError::Host)
    }
    pub(in crate::installing_broker) fn prepare_cold(
        &self,
        end: Instant,
    ) -> Result<ColdPreparation> {
        self.cold_runtime()?
            .prepare_laptop_cold_temporary(&self.workflow, end)
            .map_err(NetworkStorageError::Host)
    }
    pub(in crate::installing_broker) fn create_for_connection(
        &self,
        telemetry: &CommandTelemetry,
        connection: &WorkerLaunchConnection,
    ) -> Result<LaptopCreation> {
        self.cold_runtime()?
            .create_laptop_for_connection(&self.workflow, telemetry, connection)
            .map_err(NetworkStorageError::Host)
    }
    pub(in crate::installing_broker) fn publish_created(
        &self,
        created: &CreatedLaptop,
    ) -> Result<()> {
        self.cold_runtime()?
            .publish_laptop_launch(created)
            .map_err(NetworkStorageError::Host)
    }
    pub(in crate::installing_broker) fn start_for_connection(
        &self,
        created: &CreatedLaptop,
        connection: &WorkerLaunchConnection,
    ) -> Result<ContainerStart> {
        self.cold_runtime()?
            .start_laptop_container_for_connection(created, connection)
            .map_err(NetworkStorageError::Host)
    }
    pub(in crate::installing_broker) fn begin_memory(
        &self,
        started: &StartedContainer,
        connection: &WorkerLaunchConnection,
        effective: Option<&EffectiveWorkerConfig>,
    ) -> Result<WorkerMemoryBegin> {
        self.cold_runtime()?
            .begin_started_laptop_memory_for_connection(started, connection, effective)
            .map_err(NetworkStorageError::Host)
    }
    pub(in crate::installing_broker) fn apply_memory(
        &self,
        observed: &StartedMemoryPolicy,
        connection: &WorkerLaunchConnection,
        digest: &WorkerPolicyDigest,
    ) -> Result<WorkerMemoryEffect> {
        self.cold_runtime()?
            .apply_started_laptop_memory_for_connection(observed, connection, digest)
            .map_err(NetworkStorageError::Host)
    }
    pub(in crate::installing_broker) fn finish_memory(
        &self,
        observed: &StartedMemoryReadback,
        connection: &WorkerLaunchConnection,
        effective: &EffectiveWorkerConfig,
        digest: Option<&WorkerPolicyDigest>,
    ) -> Result<MemoryConfiguration> {
        self.cold_runtime()?
            .finish_started_laptop_memory_for_connection(observed, connection, effective, digest)
            .map_err(NetworkStorageError::Host)
    }
    pub(in crate::installing_broker) fn reject_memory_policy(
        &self,
        observed: &StartedMemoryPolicy,
        connection: &WorkerLaunchConnection,
    ) -> Result<MemoryConfiguration> {
        // Cleanup uses the actual token/original-J identity even after forward
        // progress, a registry wait or the stop budget has been revoked.
        self.destination
            .registry()
            .runtime
            .reject_started_laptop_memory_policy_for_connection(observed, connection)
            .map_err(NetworkStorageError::Host)
    }
    pub(in crate::installing_broker) fn reject_memory_readback(
        &self,
        observed: &StartedMemoryReadback,
        connection: &WorkerLaunchConnection,
    ) -> Result<MemoryConfiguration> {
        self.destination
            .registry()
            .runtime
            .reject_started_laptop_memory_readback_for_connection(observed, connection)
            .map_err(NetworkStorageError::Host)
    }
    pub(in crate::installing_broker) fn commit_cold(
        &self,
        memory: &ConfiguredMemory,
        end: Instant,
    ) -> Result<ColdCommit> {
        self.cold_runtime()?
            .commit_started_laptop_cold(memory, end)
            .map_err(NetworkStorageError::Host)
    }
    pub(in crate::installing_broker) fn start_pane(
        &self,
        cold: &ColdCommitted,
        connection: &WorkerLaunchConnection,
    ) -> Result<PaneStart> {
        self.cold_runtime()?
            .start_laptop_pane_for_connection(cold, connection)
            .map_err(NetworkStorageError::Host)
    }
    pub(in crate::installing_broker) fn close_nix_guard(
        &self,
        pane: &StartedPane,
        end: Instant,
    ) -> Result<NixGuardRelease> {
        self.cold_runtime()?
            .release_laptop_nix_guard(pane, end)
            .map_err(NetworkStorageError::Host)
    }
}
