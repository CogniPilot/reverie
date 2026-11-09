//! Actual legacy C stop-laptops consumer. It grants no pool administration.
use super::fleet_drain::{DrainCause, LegacyFleetDrain};
use super::*;
use reverie_contracts::worker_control::WorkerControlRequest;
use reverie_host::{
    worker_reports::{
        WorkerLaunchClose, WorkerLaunchHold, WorkerServiceConnection, WorkerServicePurpose,
    },
    worker_source_stop::{ControlStopCensus, SourceStopError},
};
use std::{
    fmt,
    rc::Rc,
    time::{Duration, Instant},
};
mod query;
#[cfg(test)]
mod tests;

#[derive(Debug)]
enum Cause {
    Gate(GateError),
    Storage(StorageWorkflowError),
    Native(SourceStopError),
    Drain(DrainCause),
    Report(reverie_host::worker_reports::WorkerReportError),
    Identity(Arc<reverie_store::storage_identity::IdentityError>),
    Observation(Arc<crate::reservation_observer::ObserverError>),
    Provider(Rc<reverie_host::website_facts::WebsiteFactsError>),
    Refused(&'static str),
}
impl fmt::Display for Cause {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Gate(e) => e.fmt(out),
            Self::Storage(e) => e.fmt(out),
            Self::Native(e) => e.fmt(out),
            Self::Drain(e) => e.fmt(out),
            Self::Report(e) => e.fmt(out),
            Self::Identity(e) => e.fmt(out),
            Self::Observation(e) => e.fmt(out),
            Self::Provider(e) => e.fmt(out),
            Self::Refused(e) => out.write_str(e),
        }
    }
}
impl From<GateError> for Cause {
    fn from(e: GateError) -> Self {
        Self::Gate(e)
    }
}
impl From<StorageWorkflowError> for Cause {
    fn from(e: StorageWorkflowError) -> Self {
        Self::Storage(e)
    }
}
impl From<SourceStopError> for Cause {
    fn from(e: SourceStopError) -> Self {
        Self::Native(e)
    }
}
impl From<reverie_host::worker_reports::WorkerReportError> for Cause {
    fn from(e: reverie_host::worker_reports::WorkerReportError) -> Self {
        Self::Report(e)
    }
}

impl From<DrainCause> for Cause {
    fn from(e: DrainCause) -> Self {
        Self::Drain(e)
    }
}
struct Frame<'a> {
    broker: &'a Arc<InstallingBroker>,
    connection: WorkerServiceConnection,
    action: Option<WorkerControlRequest>,
    hold: Option<WorkerLaunchHold>,
    census: Option<ControlStopCensus>,
    native: Option<Box<LegacyFleetDrain<'a>>>,
    end: Instant,
    completed: bool,
    identity_unknown: Option<Arc<reverie_store::storage_identity::IdentityError>>,
    health: Option<query::HealthReaders>,
}
pub(in crate::installing_broker) struct ControlFailure<'a> {
    owner: Option<Box<Frame<'a>>>,
    causes: Vec<Cause>,
}
impl fmt::Display for ControlFailure<'_> {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        for cause in &self.causes {
            writeln!(out, "{cause}")?;
        }
        Ok(())
    }
}
impl InstallingBroker {
    pub(in crate::installing_broker) fn handle_control<'a>(
        self: &'a Arc<Self>,
        connection: WorkerServiceConnection,
    ) -> Result<(), Box<ControlFailure<'a>>> {
        let mut owner = Box::new(Frame {
            broker: self,
            connection,
            action: None,
            hold: None,
            census: None,
            native: None,
            end: Instant::now() + Duration::from_secs(120),
            completed: false,
            identity_unknown: None,
            health: None,
        });
        match owner.run() {
            Ok(()) => Ok(()),
            Err(cause) => {
                let delivery = owner.connection.report_failure(&cause.to_string());
                let mut causes = vec![cause];
                if let Err(cause) = delivery {
                    causes.push(Cause::Report(cause));
                }
                Err(Box::new(ControlFailure {
                    owner: Some(owner),
                    causes,
                }))
            }
        }
    }
}
impl Frame<'_> {
    fn run(&mut self) -> Result<(), Cause> {
        if self.connection.purpose() != WorkerServicePurpose::Control
            || !self.connection.same_runtime(&self.broker.storage.runtime)
        {
            return Err(Cause::Refused("WORKER_CONTROL_ORIGIN"));
        }
        self.connection.assert_service(&self.broker.reports)?;
        let request = WorkerControlRequest::decode(self.connection.request_bytes())
            .map_err(Cause::Refused)?;
        self.hold = Some(self.connection.retain_lifecycle()?);
        match self.action.insert(request) {
            WorkerControlRequest::Status => return self.status(),
            WorkerControlRequest::ProviderHealth => return self.provider_health(),
            WorkerControlRequest::StorageStatus => return self.storage_status(),
            WorkerControlRequest::UnsupportedStopAgent => return self.unsupported_stop(),
            WorkerControlRequest::StopLaptops => {}
        }
        self.stop_laptops()
    }
    fn stop_laptops(&mut self) -> Result<(), Cause> {
        let drain = self
            .native
            .get_or_insert_with(|| Box::new(LegacyFleetDrain::new(self.broker, self.end)));
        drain.run_ordinary()?;
        self.connection
            .reply_json(br#"{"action":"stop-laptops","success":true}"#)?;
        self.close_transport()?;
        self.completed = true;
        Ok(())
    }
    fn close_transport(&mut self) -> Result<(), Cause> {
        let socket = self.connection.close_socket_for_worker();
        let readers = self.close_health_readers();
        socket?;
        readers?;
        if let Some(cause) = &self.identity_unknown {
            return Err(Cause::Identity(Arc::clone(cause)));
        }
        if let Some(hold) = &mut self.hold {
            hold.release_for_worker()?;
        }
        match self.connection.close_socket_for_worker()? {
            WorkerLaunchClose::SocketClosedLifecycleHeld => {
                Err(Cause::Refused("WORKER_CONTROL_LIFECYCLE_HELD"))
            }
            _ => Ok(()),
        }
    }
}
impl ControlFailure<'_> {
    pub(in crate::installing_broker) fn reconcile_known_refusal(&mut self) -> bool {
        let readonly = self
            .owner
            .as_ref()
            .and_then(|owner| owner.action.as_ref())
            .is_some_and(|action| {
                matches!(
                    action,
                    WorkerControlRequest::Status
                        | WorkerControlRequest::ProviderHealth
                        | WorkerControlRequest::StorageStatus
                )
            });
        (readonly
            || matches!(
                self.causes.first(),
                Some(Cause::Refused(_) | Cause::Drain(DrainCause::Refused(_)))
            ))
            && self.reconcile()
    }
    pub(in crate::installing_broker) fn reconcile(&mut self) -> bool {
        let Some(owner) = self.owner.as_mut() else {
            return true;
        };
        let runtime = &owner.broker.storage.runtime;
        let mut known = true;
        if let Some(census) = &mut owner.census
            && let Err(cause) = census.settle(runtime, owner.end)
        {
            known = false;
            self.causes.push(cause.into());
        }
        if let Some(native) = &mut owner.native {
            let failures = native.settle_components();
            known &= failures.is_empty();
            self.causes.extend(failures.into_iter().map(Cause::Drain));
            if !known || native.retained() {
                return false;
            }
            if let Err(cause) = native.abort_admission() {
                self.causes.push(cause.into());
                return false;
            }
        }
        if !known {
            return false;
        }
        match owner.close_transport() {
            Ok(()) => {
                owner.completed = true;
                self.owner = None;
                true
            }
            Err(cause) => {
                // These exact read owners already retain their first typed
                // failure. Reconcile cannot replay a read or grow diagnostics.
                if !matches!(
                    cause,
                    Cause::Identity(_) | Cause::Observation(_) | Cause::Provider(_)
                ) {
                    self.causes.push(cause);
                }
                false
            }
        }
    }
}
impl Drop for ControlFailure<'_> {
    fn drop(&mut self) {
        if let Some(owner) = self.owner.take() {
            std::mem::forget((Arc::clone(owner.broker), owner));
        }
    }
}
impl Drop for Frame<'_> {
    fn drop(&mut self) {
        if !self.completed {
            std::mem::forget((
                Arc::clone(self.broker),
                self.hold.take(),
                self.native.take(),
                self.census.take(),
                self.health.take(),
            ));
        }
    }
}
