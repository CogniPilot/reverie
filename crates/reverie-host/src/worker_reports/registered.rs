//! Register before actual thread construction and before peer/frame parsing.
//! This move-only token is the SAME counted record consumed by the fixed reader.
use super::*;
use reverie_contracts::worker_config::EffectiveWorkerConfig;

#[must_use = "retain the actual unread socket through handler construction"]
pub struct RegisteredWorkerConnection {
    service: Arc<WorkerReportService>,
    record: Option<Arc<Record>>,
    finish: Finish,
}
#[derive(Clone, Copy)]
enum Finish {
    Component,
    Worker,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WorkerHandlersProgress {
    Settled,
    Pending,
}
impl WorkerReportService {
    pub fn register_worker_connection(
        self: &Arc<Self>,
        stream: UnixStream,
    ) -> Result<RegisteredWorkerConnection> {
        let record = self.admit(stream)?;
        Ok(RegisteredWorkerConnection {
            service: self.clone(),
            record: Some(record),
            finish: Finish::Component,
        })
    }
    /// The actual main service joins finished/failed handlers; it creates no
    /// replacement runner and never releases a still-held lifecycle record.
    pub fn settle_worker_handlers(&self, deadline: Instant) -> Result<()> {
        let end = self
            .engine
            .stop_deadline()
            .map_or(deadline, |stop| stop.min(deadline));
        let records = self.lock_until(end)?.clone();
        let budget = budget::CleanupBudget::bounded(self, end);
        let mut result = Ok(());
        for record in &records {
            result = finalized(result, record.settle_handler(&budget, end));
        }
        let mut retained = self.lock_until(end)?;
        retained.retain(|record| !record.settled());
        finalized(
            result,
            if self.opaque.load(Ordering::Acquire) {
                Err(WorkerReportError::Unconfirmed)
            } else {
                Ok(())
            },
        )
    }
    pub fn collect_worker_handlers(&self) -> Result<WorkerHandlersProgress> {
        let records = self
            .records
            .try_lock()
            .map_err(|_| WorkerReportError::Unconfirmed)?
            .clone();
        let mut pending = false;
        for record in &records {
            pending |= !record.collect_handler()?;
        }
        let mut retained = self
            .records
            .try_lock()
            .map_err(|_| WorkerReportError::Unconfirmed)?;
        retained.retain(|record| !record.settled());
        if self.opaque.load(Ordering::Acquire) {
            return Err(WorkerReportError::Unconfirmed);
        }
        Ok(if pending {
            WorkerHandlersProgress::Pending
        } else {
            WorkerHandlersProgress::Settled
        })
    }
    pub(super) fn finish_registered(&self, record: &Arc<Record>) -> Result<()> {
        self.finish_accepted(record)
    }
    pub(super) fn finish_registered_for_worker(&self, record: &Arc<Record>) -> Result<()> {
        self.finish_accepted_for_worker(record)
    }
}
impl RegisteredWorkerConnection {
    /// Fixed App handler entry calls this BEFORE configuration or payload work.
    /// A second call on the same thread is identity-only; another thread cannot
    /// adopt a published handler's record.
    pub fn await_handler_publication(&mut self) -> Result<()> {
        self.record
            .as_ref()
            .expect("unconsumed registered token")
            .enter_handler(&self.service)
    }
    pub fn same_runtime(&self, runtime: &WorkerRuntime) -> bool {
        Arc::ptr_eq(&self.service.engine, runtime.installed_engine())
    }
    pub fn reserve_handler(&mut self) -> Result<super::WorkerHandlerConstruction> {
        self.finish = Finish::Worker;
        super::handler::WorkerHandlerConstruction::new(
            self.service.clone(),
            self.record
                .as_ref()
                .expect("unconsumed registered token")
                .clone(),
        )
    }
    pub fn receive(
        self,
        collector: &CommandTelemetry,
        configuration: &EffectiveWorkerConfig,
    ) -> Result<AcceptedWorkerConnection> {
        self.receive_inner(collector, configuration)
    }
    pub fn receive_for_worker(
        mut self,
        collector: &CommandTelemetry,
        configuration: &EffectiveWorkerConfig,
    ) -> Result<AcceptedWorkerConnection> {
        self.finish = Finish::Worker;
        self.receive_inner(collector, configuration)
    }
    fn receive_inner(
        mut self,
        collector: &CommandTelemetry,
        configuration: &EffectiveWorkerConfig,
    ) -> Result<AcceptedWorkerConnection> {
        let entered = self.await_handler_publication();
        let record = self.record.take().expect("one initial read");
        let request =
            entered.and_then(|()| record.read_request(&self.service, collector, configuration));
        match request {
            Ok(Some(request)) => Ok(AcceptedWorkerConnection::Launch(
                super::launch::WorkerLaunchConnection::from_registered(
                    self.service.clone(),
                    record,
                    request,
                ),
            )),
            Ok(None) => {
                self.finish_record(&record)?;
                Ok(AcceptedWorkerConnection::ReportCompleted)
            }
            Err(error) => finalized(Err(error), self.finish_record(&record)),
        }
    }
    pub fn close(mut self) -> Result<()> {
        self.close_inner()
    }
    pub fn close_for_worker(mut self) -> Result<()> {
        self.finish = Finish::Worker;
        self.close_inner()
    }
    fn close_inner(&mut self) -> Result<()> {
        let record = self.record.take().expect("one registered close");
        record.note_unread_drop();
        self.finish_record(&record)
    }
    fn finish_record(&self, record: &Arc<Record>) -> Result<()> {
        match self.finish {
            Finish::Component => self.service.finish_registered(record),
            Finish::Worker => self.service.finish_registered_for_worker(record),
        }
    }
}
impl Drop for RegisteredWorkerConnection {
    fn drop(&mut self) {
        if let Some(record) = self.record.take() {
            record.note_unread_drop();
            let _ = self.finish_record(&record);
        }
    }
}
