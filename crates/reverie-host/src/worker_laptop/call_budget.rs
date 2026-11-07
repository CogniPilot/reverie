//! Component ceilings and source's actual ordinary worker purpose share one
//! algorithm. None is never exposed as a request-selected deadline or grant.
use super::*;
use crate::worker_reports::WorkerLaunchConnection;
#[derive(Clone, Copy)]
pub(super) struct CallBudget(Option<Instant>);
impl CallBudget {
    pub(super) fn bounded(end: Instant) -> Self {
        Self(Some(end))
    }
    pub(super) fn worker() -> Self {
        Self(None)
    }
    pub(super) fn ceiling(self) -> Option<Instant> {
        self.0
    }
    pub(super) fn end(self, runtime: &WorkerRuntime, seconds: u64) -> Instant {
        let end = Instant::now() + std::time::Duration::from_secs(seconds);
        [self.0, runtime.stop_deadline()]
            .into_iter()
            .flatten()
            .fold(end, Instant::min)
    }
    pub(super) fn check(self, runtime: &WorkerRuntime) -> Result<()> {
        let now = Instant::now();
        need(
            [self.0, runtime.stop_deadline()]
                .into_iter()
                .flatten()
                .all(|end| now < end),
            "WORKER_LAPTOP_DEADLINE",
        )
    }
}
impl Workflows {
    pub(super) fn assert_worker_connection(
        &self,
        runtime: &WorkerRuntime,
        workflow: &LaptopWorkflow,
        connection: &WorkerLaunchConnection,
    ) -> Result<()> {
        self.bound(runtime, workflow)?;
        let record = workflow
            .record
            .try_lock()
            .map_err(|_| LaptopError::Refused("WORKER_LAPTOP_RETAINED"))?;
        let resources = record
            .resources
            .as_ref()
            .ok_or(LaptopError::Refused("WORKER_LAPTOP_REPLAYED"))?;
        let original = resources
            .connection
            .as_ref()
            .ok_or(LaptopError::Refused("WORKER_LAPTOP_CONNECTION_REQUIRED"))?;
        let supplied = connection
            .viewer_constructor_identity(runtime, resources.plan.session())
            .map_err(LaptopError::Refused)?;
        need(
            original.same(&supplied) && original.can_progress(),
            "WORKER_LAPTOP_CONNECTION_CHANGED",
        )
    }
    pub(super) fn assert_worker_cleanup_connection(
        &self,
        runtime: &WorkerRuntime,
        workflow: &LaptopWorkflow,
        connection: &WorkerLaunchConnection,
    ) -> Result<()> {
        self.bound(runtime, workflow)?;
        let record = workflow
            .record
            .try_lock()
            .map_err(|_| LaptopError::Refused("WORKER_LAPTOP_RETAINED"))?;
        let resources = record
            .resources
            .as_ref()
            .ok_or(LaptopError::Refused("WORKER_LAPTOP_REPLAYED"))?;
        let original = resources
            .connection
            .as_ref()
            .ok_or(LaptopError::Refused("WORKER_LAPTOP_CONNECTION_REQUIRED"))?;
        need(
            connection.has_viewer_identity(original),
            "WORKER_LAPTOP_CONNECTION_CHANGED",
        )
    }
}
impl WorkerRuntime {
    pub fn run_laptop_network_for_connection(
        &self,
        workflow: &LaptopWorkflow,
        connection: &WorkerLaunchConnection,
    ) -> Result<LaptopNetworkProgress> {
        self.laptop_workflows()
            .assert_worker_connection(self, workflow, connection)?;
        self.laptop_workflows()
            .run_network(self, workflow, CallBudget::worker())
    }
}
