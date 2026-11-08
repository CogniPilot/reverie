//! Concrete listener and fixed registered handler. There is no callback runner
//! or readiness grant. Missing mandatory L/Q/service consumers remain explicit.
use super::*;
use reverie_host::worker_reports::{WorkerBrokerListener, WorkerReportError};
mod handler;
mod shutdown;
mod supervisor;
pub(in crate::installing_broker) use shutdown::ClosedBrokerResources;

#[derive(Debug)]
pub enum BrokerServiceError {
    Listener(BrokerListenerError),
    Handler(WorkerReportError),
    Runtime(reverie_host::worker_runtime::RuntimeError),
    Telemetry(TelemetryCloseError),
    Signal(reverie_host::worker_runtime::BrokerSignalError),
    Recovery(RecoveryError),
    Images(ChatImagesError),
    InstallationOffer(reverie_host::worker_pool::PoolError),
    Controller(reverie_host::worker_pool::PoolError),
    Supervisor(String),
    Shutdown(Vec<BrokerServiceError>),
}
impl fmt::Display for BrokerServiceError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Listener(error) => error.fmt(out),
            Self::Handler(error) => error.fmt(out),
            Self::Runtime(error) => error.fmt(out),
            Self::Telemetry(error) => error.fmt(out),
            Self::Signal(error) => error.fmt(out),
            Self::Recovery(error) => error.fmt(out),
            Self::Images(error) => error.fmt(out),
            Self::InstallationOffer(error) => error.fmt(out),
            Self::Controller(error) => error.fmt(out),
            Self::Supervisor(error) => out.write_str(error),
            Self::Shutdown(errors) => write!(
                out,
                "WORKER_SERVICE_SHUTDOWN_RETAINED: {}",
                errors
                    .iter()
                    .map(ToString::to_string)
                    .collect::<Vec<_>>()
                    .join("; ")
            ),
        }
    }
}
impl std::error::Error for BrokerServiceError {}
#[must_use = "retain original listener, signals, broker and counted handler owners"]
pub struct BrokerService {
    startup: BrokerServiceStartup,
    listener: WorkerBrokerListener,
    shutdown_attempted: bool,
    supervisor: std::cell::RefCell<Option<super::super::supervisor::DetachedStopFailure>>,
}
#[must_use = "failed shutdown is not a resource/global acknowledgement"]
pub struct BrokerServiceFailure {
    service: BrokerService,
    cause: BrokerServiceError,
}
#[derive(Debug)]
pub struct BrokerServiceClosed {
    termination_signal: Option<i32>,
}
impl BrokerServiceClosed {
    pub fn termination_signal(&self) -> Option<i32> {
        self.termination_signal
    }
}
impl fmt::Debug for BrokerServiceFailure {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.debug_struct("BrokerServiceFailure")
            .field("cause", &self.cause)
            .finish_non_exhaustive()
    }
}
impl fmt::Display for BrokerServiceFailure {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.cause.fmt(out)
    }
}
impl std::error::Error for BrokerServiceFailure {}
impl BrokerServiceStartup {
    /// Recovery already preceded this consuming bind. No readiness is emitted.
    pub fn bind_listener(mut self) -> Result<BrokerService, Box<BrokerStartupFailure>> {
        if let Err(cause) = self.owner.assert_installation_offer() {
            return Err(Box::new(BrokerStartupFailure {
                owner: self.owner,
                cause,
            }));
        }
        let prepared = self.owner.listener.take().expect("same prepared listener");
        match prepared.bind() {
            Ok(listener) => self.owner.bound_listener = Some(listener),
            Err(cause) => {
                return Err(Box::new(BrokerStartupFailure {
                    owner: self.owner,
                    cause: BrokerStartupCause::Listener(cause),
                }));
            }
        }
        // The real bound descriptor/name is retained BEFORE this fallible
        // original-deadline/origin check; failure returns the whole owner.
        if let Err(cause) = self.owner.assert_installation_offer() {
            return Err(Box::new(BrokerStartupFailure {
                owner: self.owner,
                cause,
            }));
        }
        let listener = self
            .owner
            .bound_listener
            .take()
            .expect("same bound listener");
        Ok(BrokerService {
            startup: self,
            listener,
            shutdown_attempted: false,
            supervisor: std::cell::RefCell::new(None),
        })
    }
}
impl BrokerService {
    /// Original count/record is reserved BEFORE actual std thread construction;
    /// its concrete JoinHandle is published before the child's first read.
    pub fn poll_handler(&self) -> Result<(), BrokerServiceError> {
        let broker = &self.startup.owner.broker;
        broker
            .reports
            .collect_worker_handlers()
            .map_err(BrokerServiceError::Handler)?;
        self.poll_supervisor();
        let Some(mut registered) = self
            .listener
            .accept(&broker.reports)
            .map_err(BrokerServiceError::Listener)?
        else {
            return Ok(());
        };
        let mut construction = registered
            .reserve_handler()
            .map_err(BrokerServiceError::Handler)?;
        let inbox = construction
            .retain_reconciliation()
            .map_err(BrokerServiceError::Handler)?;
        let broker = broker.clone();
        let installation_offer = self.startup.owner.installation_offer.clone();
        let spawned = std::thread::Builder::new()
            .name("reverie-worker-handler".into())
            .spawn(move || handler::run(broker, registered, inbox, installation_offer));
        match spawned {
            Ok(thread) => construction.publish(thread),
            Err(error) => construction.spawn_failed(error),
        }
        .map_err(BrokerServiceError::Handler)
    }
    pub fn run(mut self) -> Result<BrokerServiceClosed, Box<BrokerServiceFailure>> {
        let mut errors = Vec::new();
        while !self
            .startup
            .owner
            .broker
            .storage
            .runtime
            .cancellation()
            .is_cancelled()
        {
            if let Err(error) = self.poll_handler() {
                errors.push(error);
                self.startup.request_stop();
            }
        }
        match self.shutdown(&mut errors) {
            Ok(closed) => Ok(closed),
            Err(()) => Err(Box::new(BrokerServiceFailure {
                service: self,
                cause: BrokerServiceError::Shutdown(errors),
            })),
        }
    }
}
impl BrokerServiceFailure {
    /// Settle only native work already retained by this SAME failed service.
    /// Uses its original first stop, never seals/reopens the client, repeats a
    /// service body or claims App/report/global closure. The primary stays put.
    pub fn settle_original_native_work(
        &mut self,
    ) -> Result<(), reverie_host::worker_runtime::RuntimeError> {
        let runtime = &self.service.startup.owner.broker.storage.runtime;
        let end = runtime
            .stop_deadline()
            .unwrap_or_else(|| runtime.request_stop());
        runtime.settle_owned(end)
    }
    /// Original metadata component only; no native/app/handler/global closure
    /// or healthy broker release is implied. The historical cause stays intact.
    pub fn close_installation_origin_metadata(
        &mut self,
    ) -> Result<(), reverie_host::worker_pool::PoolError> {
        self.service
            .startup
            .owner
            .close_installation_origin_metadata()
    }
    pub fn cause(&self) -> &BrokerServiceError {
        &self.cause
    }
    /// Ask the same original handler stacks to settle only supported remaining
    /// phases. This never repeats startup, a J body or a destructive request.
    pub fn reconcile_handlers(
        &mut self,
    ) -> Result<reverie_host::worker_reports::WorkerHandlersProgress, WorkerReportError> {
        let runtime = &self.service.startup.owner.broker.storage.runtime;
        let end = runtime
            .stop_deadline()
            .unwrap_or_else(|| runtime.request_stop());
        self.service
            .startup
            .owner
            .broker
            .reports
            .reconcile_worker_handlers(end)
    }
}
