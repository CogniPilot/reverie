//! The registry retains the original workflow while the caller retains the
//! original controller slot. No workflow or runtime is reconstructed or cloned.
use super::*;
use crate::installing_broker::installed_controller::{
    InstalledControllerBorrow, InstalledMemberCreation,
};
use reverie_host::{
    command_telemetry::CommandTelemetry,
    worker_laptop::{
        ContainerStart, ControllerMemberConfigured, CreatedLaptop, LaptopCreation, StartedContainer,
    },
    worker_reports::WorkerLaunchConnection,
};
type Result<T> = std::result::Result<T, NetworkStorageError>;

impl NetworkStoragePreparation {
    pub(in crate::installing_broker) fn prepare_controller_member<'owner>(
        &self,
        controller: &'owner mut InstalledControllerBorrow<'_>,
        connection: &WorkerLaunchConnection,
        end: Instant,
    ) -> Result<InstalledMemberCreation<'owner>> {
        self.check()?;
        controller
            .prepare_workflow_member(&self.workflow, connection, end)
            .map_err(NetworkStorageError::Controller)
    }

    pub(in crate::installing_broker) fn create_controller_member(
        &self,
        member: &mut InstalledMemberCreation<'_>,
        telemetry: &CommandTelemetry,
        connection: &WorkerLaunchConnection,
    ) -> Result<LaptopCreation> {
        self.check()?;
        member
            .create_for_connection(&self.workflow, telemetry, connection)
            .map_err(NetworkStorageError::Host)
    }

    pub(in crate::installing_broker) fn publish_controller_member(
        &self,
        member: &mut InstalledMemberCreation<'_>,
        created: &CreatedLaptop,
        connection: &WorkerLaunchConnection,
    ) -> Result<()> {
        self.check()?;
        member
            .publish_for_connection(created, connection)
            .map_err(NetworkStorageError::Host)
    }

    pub(in crate::installing_broker) fn start_controller_member(
        &self,
        member: &mut InstalledMemberCreation<'_>,
        created: &CreatedLaptop,
        connection: &WorkerLaunchConnection,
    ) -> Result<ContainerStart> {
        self.check()?;
        member
            .start_for_connection(created, connection)
            .map_err(NetworkStorageError::Host)
    }

    pub(in crate::installing_broker) fn configure_controller_member(
        &self,
        member: &mut InstalledMemberCreation<'_>,
        created: &CreatedLaptop,
        started: &StartedContainer,
        connection: &WorkerLaunchConnection,
    ) -> Result<ControllerMemberConfigured> {
        self.check()?;
        member
            .configure_member(created, started, connection)
            .map_err(NetworkStorageError::Controller)
    }
}
