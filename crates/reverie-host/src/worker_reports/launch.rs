//! The actual J connection shares T's bounded native registry. This value is
//! peer/request/resource provenance, never allocation or permission to start.
use super::*;
use reverie_contracts::{worker_config::EffectiveWorkerConfig, worker_launch::WorkerRequest};

#[must_use = "retain the actual accepted connection until checked close"]
pub struct WorkerLaunchConnection {
    service: Arc<WorkerReportService>,
    record: Arc<Record>,
    request: WorkerRequest,
}
/// A completed report or an actual still-owned J socket. No decoded request
/// can manufacture either branch or transfer ownership from a different run.
pub enum AcceptedWorkerConnection {
    ReportCompleted,
    Launch(WorkerLaunchConnection),
}
impl WorkerReportService {
    /// A current-configuration failure still consumes the actual accepted
    /// socket through this same registry and checked finalizer owner.
    pub fn close_unread_launch(&self, stream: UnixStream) -> Result<()> {
        let record = self.admit(stream)?;
        self.finish_accepted(&record)
    }
    /// Register before reading; check the kernel UID before any frame/request.
    /// Configuration is ordinary captured data, not a substitute for App's
    /// actual optional admission, current intent or held lifecycle.
    pub fn accept(
        self: &Arc<Self>,
        stream: UnixStream,
        collector: &CommandTelemetry,
        configuration: &EffectiveWorkerConfig,
    ) -> Result<AcceptedWorkerConnection> {
        self.register_worker_connection(stream)?
            .receive(collector, configuration)
    }
    pub(super) fn finish_accepted(&self, record: &Arc<Record>) -> Result<()> {
        let end = self
            .engine
            .stop_deadline()
            .unwrap_or_else(|| Instant::now() + Duration::from_secs(10));
        self.finish_accepted_budget(record, &super::budget::CleanupBudget::bounded(self, end))
    }
    pub(super) fn finish_accepted_for_worker(&self, record: &Arc<Record>) -> Result<()> {
        self.finish_accepted_budget(record, &super::budget::CleanupBudget::worker(self))
    }
    fn finish_accepted_budget(
        &self,
        record: &Arc<Record>,
        budget: &super::budget::CleanupBudget<'_>,
    ) -> Result<()> {
        let result = record.finish_launch(budget);
        finalized(
            result,
            self.retire_launch(record, budget)
                .and_then(|state| match state {
                    WorkerLaunchClose::Complete
                    | WorkerLaunchClose::SocketClosedHandlerRetained => Ok(()),
                    WorkerLaunchClose::SocketClosedLifecycleHeld => {
                        Err(WorkerReportError::LifecycleRetained)
                    }
                }),
        )
    }
    fn retire_launch(
        &self,
        record: &Arc<Record>,
        budget: &super::budget::CleanupBudget<'_>,
    ) -> Result<WorkerLaunchClose> {
        let mut records = self.lock_budget(budget)?;
        let state = record.lifecycle_until(budget)?;
        if !record.socket_closed_known() {
            return Err(WorkerReportError::Unconfirmed);
        }
        if matches!(*state, super::retention::LifecycleHoldState::Held(_)) {
            return Ok(WorkerLaunchClose::SocketClosedLifecycleHeld);
        }
        if !record.handler_settled() {
            return Ok(WorkerLaunchClose::SocketClosedHandlerRetained);
        }
        records.retain(|other| !Arc::ptr_eq(other, record));
        Ok(WorkerLaunchClose::Complete)
    }
}
impl WorkerLaunchConnection {
    pub(super) fn from_registered(
        service: Arc<WorkerReportService>,
        record: Arc<Record>,
        request: WorkerRequest,
    ) -> Self {
        Self {
            service,
            record,
            request,
        }
    }
    pub(super) fn require_terminal_hold(&self) -> Result<()> {
        self.record.require_terminal_hold()
    }
    pub(super) fn terminal_identity(&self) -> super::terminal::RelayIdentity {
        super::terminal::RelayIdentity::new(&self.service, self.record.clone())
    }
    pub(crate) fn viewer_constructor_identity(
        &self,
        runtime: &WorkerRuntime,
        session: &reverie_core::ids::ProfileSessionId,
    ) -> std::result::Result<super::terminal::RelayIdentity, &'static str> {
        if !self.same_runtime(runtime) {
            return Err("VIEWER_CONNECTION_RUNTIME_CHANGED");
        }
        if self.request.session() != session {
            return Err("VIEWER_CONNECTION_SESSION_CHANGED");
        }
        self.assert_open(runtime)
            .map_err(|_| "VIEWER_CONNECTION_CLOSED")?;
        self.require_terminal_hold()
            .map_err(|_| "VIEWER_CONNECTION_HOLD_REQUIRED")?;
        Ok(self.terminal_identity())
    }
    pub(super) fn terminal_socket(&self) -> Result<super::terminal::socket::Socket<'_>> {
        if self.service.stopping() {
            return Err(WorkerReportError::Stopping);
        }
        let stream = self.record.terminal_stream()?;
        Ok(super::terminal::socket::Socket::new(&self.service, stream))
    }
    /// One-shot nonblocking mint from this actual accepted J record. The real
    /// application keeps this with its active/preparation/failure owner. This
    /// value retains transport capacity, never grants native effects.
    pub fn retain_lifecycle(&self) -> Result<WorkerLaunchHold> {
        self.record.retain_lifecycle(&self.service)
    }
    /// Identity/liveness of an already-issued resource hold. This neither
    /// constructs a hold nor grants a native operation or storage ownership.
    pub fn assert_lifecycle_hold(&self, hold: &WorkerLaunchHold) -> Result<()> {
        if !Arc::ptr_eq(&self.service, &hold.service)
            || !Arc::ptr_eq(&self.record, &hold.record)
            || self.service.stopping()
            || !self.record.can_progress()
        {
            return Err(WorkerReportError::Unconfirmed);
        }
        self.record.assert_lifecycle_hold(&hold.identity)
    }
    /// Pure origin identity for negative handler bookkeeping after its socket
    /// closed. This proves neither open/progress state nor a releasable hold.
    pub fn assert_same_lifecycle_record(&self, hold: &WorkerLaunchHold) -> Result<()> {
        if Arc::ptr_eq(&self.service, &hold.service) && Arc::ptr_eq(&self.record, &hold.record) {
            Ok(())
        } else {
            Err(WorkerReportError::Unconfirmed)
        }
    }
    pub fn assert_open(&self, runtime: &WorkerRuntime) -> Result<()> {
        if !self.same_runtime(runtime) || !self.record.can_progress() || self.service.stopping() {
            return Err(WorkerReportError::Unconfirmed);
        }
        Ok(())
    }
    pub fn request(&self) -> &WorkerRequest {
        &self.request
    }
    pub fn same_runtime(&self, runtime: &WorkerRuntime) -> bool {
        Arc::ptr_eq(&self.service.engine, runtime.installed_engine())
    }
    pub fn same_connection(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.service, &other.service) && Arc::ptr_eq(&self.record, &other.record)
    }
    /// Interrupt only this actual accepted socket, without changing another
    /// connection, the shared native engine, or the broker's stop budget.
    pub fn interrupt(&self) -> Result<()> {
        self.record.interrupt()
    }
    pub fn close(&self, requested: Instant) -> Result<()> {
        require_retired(self.close_socket(requested)?)
    }
    /// Consume the socket descriptors once, preserving a distinct known-closed
    /// lifecycle-held outcome. It does not release that actual lifecycle hold.
    pub fn close_socket(&self, requested: Instant) -> Result<WorkerLaunchClose> {
        self.close_socket_budget(&super::budget::CleanupBudget::bounded(
            &self.service,
            requested,
        ))
    }
    pub fn close_socket_for_worker(&self) -> Result<WorkerLaunchClose> {
        self.close_socket_budget(&super::budget::CleanupBudget::worker(&self.service))
    }
    fn close_socket_budget(
        &self,
        budget: &super::budget::CleanupBudget<'_>,
    ) -> Result<WorkerLaunchClose> {
        let result = self.record.finish_launch(budget);
        match result {
            Ok(()) => self.service.retire_launch(&self.record, budget),
            Err(primary) => {
                let cleanup = self.service.retire_launch(&self.record, budget).map(|_| ());
                finalized(Err(primary), cleanup)
            }
        }
    }
}
impl Drop for WorkerLaunchConnection {
    fn drop(&mut self) {
        // A contended or opaque last Drop remains in the SAME service registry
        // and ultimately its process-lifetime quarantine. No positive ACK.
        let _ = self.close_socket(Instant::now());
    }
}
fn require_retired(outcome: WorkerLaunchClose) -> Result<()> {
    match outcome {
        WorkerLaunchClose::Complete => Ok(()),
        WorkerLaunchClose::SocketClosedLifecycleHeld => Err(WorkerReportError::LifecycleRetained),
        WorkerLaunchClose::SocketClosedHandlerRetained => Err(WorkerReportError::HandlerRetained),
    }
}
