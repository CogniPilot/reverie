use super::*;
use crate::{command_telemetry::CommandTelemetry, worker_laptop::call_budget::CallBudget};

impl PoolMemberCreation<'_> {
    pub fn create_for_connection(
        &mut self,
        runtime: &WorkerRuntime,
        workflow: &LaptopWorkflow,
        telemetry: &CommandTelemetry,
        connection: &WorkerLaunchConnection,
    ) -> std::result::Result<LaptopCreation, LaptopError> {
        self.assert_workflow(runtime, workflow, connection)
            .map_err(super::super::pool_error)?;
        let end = self.end;
        let result = runtime.laptop_workflows().create(
            runtime,
            workflow,
            telemetry,
            CallBudget::bounded(end),
            Some(self),
        );
        self.retain_laptop_result(result)
    }
    pub fn publish_for_connection(
        &mut self,
        runtime: &WorkerRuntime,
        created: &CreatedLaptop,
        connection: &WorkerLaunchConnection,
    ) -> std::result::Result<(), LaptopError> {
        self.assert_workflow(runtime, &created.workflow, connection)
            .map_err(super::super::pool_error)?;
        let result = runtime.publish_laptop_launch(created);
        self.retain_laptop_result(result)
    }
    pub fn start_for_connection(
        &mut self,
        runtime: &WorkerRuntime,
        created: &CreatedLaptop,
        connection: &WorkerLaunchConnection,
    ) -> std::result::Result<ContainerStart, LaptopError> {
        self.assert_workflow(runtime, &created.workflow, connection)
            .map_err(super::super::pool_error)?;
        let end = self.end;
        let result = runtime.laptop_workflows().start(
            runtime,
            created,
            CallBudget::bounded(end),
            Some(self),
        );
        self.retain_laptop_result(result)
    }
    pub fn configure_member(
        &mut self,
        runtime: &WorkerRuntime,
        created: &CreatedLaptop,
        started: &StartedContainer,
        connection: &WorkerLaunchConnection,
    ) -> PoolResult<ControllerMemberConfigured> {
        self.assert_workflow(runtime, &created.workflow, connection)?;
        let result = self
            .controller
            .configure_created_member(runtime, created, started, connection, self.end);
        self.controller.retain_member_result(result)
    }
    fn assert_workflow(
        &mut self,
        runtime: &WorkerRuntime,
        workflow: &LaptopWorkflow,
        connection: &WorkerLaunchConnection,
    ) -> PoolResult<()> {
        let checked = (|| {
            runtime
                .laptop_workflows()
                .assert_worker_cleanup_connection(runtime, workflow, connection)
                .map_err(|_| PoolError::Refused("WORKER_POOL_CREATED_CONNECTION"))?;
            let mut record = workflow
                .record
                .try_lock()
                .map_err(|_| PoolError::Refused("WORKER_POOL_CREATED_RETAINED"))?;
            let progress = connection_progress(&mut record);
            retain_outcome(Some(self), &record);
            match progress {
                Err(PoolError::Channel(error)) => {
                    return self
                        .controller
                        .retain_member_result(Err(PoolError::Channel(error)));
                }
                other => other?,
            }
            let resources = record
                .resources
                .as_ref()
                .ok_or(PoolError::Refused("WORKER_POOL_CREATED_RESOURCES_RETURNED"))?;
            self.plan.assert_plan(runtime, &resources.plan)
        })();
        checked?;
        self.check_current(runtime)
    }
    fn retain_laptop_result<T>(
        &mut self,
        result: std::result::Result<T, LaptopError>,
    ) -> std::result::Result<T, LaptopError> {
        result.map_err(|error| {
            let original = match error {
                LaptopError::Recorded(original) => original,
                other => Arc::new(other),
            };
            if original.unconfirmed_native() {
                self.controller
                    .retain_member_cause(PoolError::Member(original.clone()));
            }
            LaptopError::Recorded(original)
        })
    }
}
