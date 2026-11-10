//! Forward effects through the same borrowed controller and original runtime.
use super::*;
use reverie_host::{
    command_telemetry::CommandTelemetry,
    worker_laptop::{ContainerStart, LaptopCreation, LaptopError, LaptopWorkflow},
};

impl InstalledMemberCreation<'_> {
    pub(in crate::installing_broker) fn create_for_connection(
        &mut self,
        workflow: &LaptopWorkflow,
        telemetry: &CommandTelemetry,
        connection: &WorkerLaunchConnection,
    ) -> Result<LaptopCreation, LaptopError> {
        self.member
            .create_for_connection(self.runtime, workflow, telemetry, connection)
    }

    pub(in crate::installing_broker) fn publish_for_connection(
        &mut self,
        created: &CreatedLaptop,
        connection: &WorkerLaunchConnection,
    ) -> Result<(), LaptopError> {
        self.member
            .publish_for_connection(self.runtime, created, connection)
    }

    pub(in crate::installing_broker) fn start_for_connection(
        &mut self,
        created: &CreatedLaptop,
        connection: &WorkerLaunchConnection,
    ) -> Result<ContainerStart, LaptopError> {
        self.member
            .start_for_connection(self.runtime, created, connection)
    }

    pub(in crate::installing_broker) fn configure_member(
        &mut self,
        created: &CreatedLaptop,
        started: &StartedContainer,
        connection: &WorkerLaunchConnection,
    ) -> Result<ControllerMemberConfigured, PoolError> {
        self.member
            .configure_member(self.runtime, created, started, connection)
    }
}
