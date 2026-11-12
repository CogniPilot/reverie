//! Closed messages to the ORIGINAL published handler. Responses are progress
//! DATA; socket, lifecycle hold and actual join remain independent prerequisites.
use super::*;
use std::sync::mpsc::{self, Receiver, SyncSender, TrySendError};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WorkerHandlerCommand {
    Status,
    Reconcile,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WorkerHandlerDisposition {
    Retained,
    Finalized,
}
pub(super) struct Request {
    command: WorkerHandlerCommand,
    reply: SyncSender<WorkerHandlerDisposition>,
}
#[must_use = "the actual handler must answer using its original retained owner"]
pub struct WorkerHandlerRequest {
    request: Request,
}
impl WorkerHandlerRequest {
    pub fn command(&self) -> WorkerHandlerCommand {
        self.request.command
    }
    pub fn answer(self, disposition: WorkerHandlerDisposition) {
        // A timed-out observer may have gone away. That releases no resource
        // and must not replace the original retained handler state.
        let _ = self.request.reply.try_send(disposition);
    }
}
#[must_use = "retain beside the original accepted handler stack"]
pub struct WorkerHandlerInbox {
    job: Arc<HandlerJob>,
    receiver: Receiver<Request>,
}
impl WorkerHandlerConstruction {
    /// Issued only by the actual constructing thread before publication. The
    /// fixed App thread moves this with the SAME registered unread connection.
    pub fn retain_reconciliation(&mut self) -> Result<WorkerHandlerInbox> {
        if self.decided || std::thread::current().id() != self.job.parent {
            return Err(WorkerReportError::Unconfirmed);
        }
        let mut slot = self
            .job
            .reconciliation
            .try_lock()
            .map_err(|_| WorkerReportError::Unconfirmed)?;
        if slot.is_some() {
            return Err(WorkerReportError::Unconfirmed);
        }
        let (sender, receiver) = mpsc::sync_channel(1);
        *slot = Some(sender);
        Ok(WorkerHandlerInbox {
            job: self.job.clone(),
            receiver,
        })
    }
}
impl WorkerHandlerInbox {
    /// This runs only after the actual same-thread publication/read barrier.
    /// The queue lives in the existing counted Job, never in a second registry.
    pub fn receive(&self) -> Result<WorkerHandlerRequest> {
        if self.job.entered.get() != Some(&std::thread::current().id())
            || !self.job.published.load(Ordering::Acquire)
        {
            self.job.opaque.store(true, Ordering::Release);
            return Err(WorkerReportError::Unconfirmed);
        }
        self.receiver
            .recv()
            .map(|request| WorkerHandlerRequest { request })
            .map_err(|_| WorkerReportError::Unconfirmed)
    }
}
impl HandlerJob {
    fn dispatch_progress(&self, command: WorkerHandlerCommand) -> Dispatch {
        if self.known_settled() {
            return Dispatch::Unavailable;
        }
        let slot = match self.reconciliation.try_lock() {
            Ok(slot) => slot,
            Err(TryLockError::WouldBlock) => return Dispatch::Contended,
            Err(TryLockError::Poisoned(_)) => return Dispatch::Poisoned,
        };
        let Some(sender) = slot.as_ref() else {
            return Dispatch::Unavailable;
        };
        let (reply, response) = mpsc::sync_channel(1);
        let request = Request { command, reply };
        match sender.try_send(request) {
            Ok(()) => Dispatch::Sent(response),
            Err(TrySendError::Full(_)) => Dispatch::Pending,
            Err(TrySendError::Disconnected(_)) => Dispatch::Unavailable,
        }
    }
    /// The original-handler owner only queues this closed existing command.
    /// It never blocks on a reply or treats a reply as record/resource closure.
    pub(in crate::worker_reports) fn try_reconcile_original(&self) -> Result<bool> {
        match self.dispatch_progress(WorkerHandlerCommand::Reconcile) {
            Dispatch::Pending | Dispatch::Contended => Ok(false),
            Dispatch::Poisoned => {
                self.opaque.store(true, Ordering::Release);
                Err(WorkerReportError::Unconfirmed)
            }
            Dispatch::Sent(_) | Dispatch::Unavailable => Ok(true),
        }
    }
    fn request_progress(&self, command: WorkerHandlerCommand, end: Instant) -> Result<()> {
        let response = match self.dispatch_progress(command) {
            Dispatch::Sent(response) => response,
            Dispatch::Contended | Dispatch::Poisoned => return Err(WorkerReportError::Unconfirmed),
            Dispatch::Pending | Dispatch::Unavailable => return Ok(()),
        };
        let _ = response.recv_timeout(self.bound(end).saturating_duration_since(Instant::now()));
        // No response, Retained and Finalized alike still require the actual
        // record/hold/socket and published-thread checks below.
        Ok(())
    }
}
enum Dispatch {
    Contended,
    Poisoned,
    Pending,
    Unavailable,
    Sent(Receiver<WorkerHandlerDisposition>),
}
impl WorkerReportService {
    /// Seal only this original admission and interrupt its actual sockets,
    /// BEFORE waiting for retained handlers' closed reconciliation commands.
    pub fn interrupt_worker_handlers(&self, requested: Instant) -> Result<()> {
        self.closed.store(true, Ordering::Release);
        let end = self
            .engine
            .stop_deadline()
            .map_or(requested, |stop| stop.min(requested));
        let records = self.lock_until(end)?.clone();
        let mut result = Ok(());
        for record in &records {
            result = finalized(result, record.interrupt());
        }
        result
    }
    /// Explicit service recovery asks each ORIGINAL handler to settle its own
    /// phases. It never reruns the handler or reconstructs any resource owner.
    pub fn reconcile_worker_handlers(&self, requested: Instant) -> Result<WorkerHandlersProgress> {
        self.request_worker_progress(WorkerHandlerCommand::Reconcile, requested)
    }
    pub fn observe_worker_handlers(&self, requested: Instant) -> Result<WorkerHandlersProgress> {
        self.request_worker_progress(WorkerHandlerCommand::Status, requested)
    }
    fn request_worker_progress(
        &self,
        command: WorkerHandlerCommand,
        requested: Instant,
    ) -> Result<WorkerHandlersProgress> {
        let end = self
            .engine
            .stop_deadline()
            .map_or(requested, |stop| stop.min(requested));
        let records = self.lock_until(end)?.clone();
        for record in records {
            if let Some(job) = record.handler_job()? {
                job.request_progress(command, end)?;
            }
        }
        if self.collect_worker_handlers()? == WorkerHandlersProgress::Pending {
            return Ok(WorkerHandlersProgress::Pending);
        }
        let records = self.lock_until(end)?;
        let budget = budget::CleanupBudget::bounded(self, end);
        for record in &*records {
            if !record.settled_until(&budget)? {
                return Ok(WorkerHandlersProgress::Pending);
            }
        }
        Ok(WorkerHandlersProgress::Settled)
    }
}
