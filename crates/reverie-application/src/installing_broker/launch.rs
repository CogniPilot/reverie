//! Actual accepted T/J connection and the original ordinary launch prefix.
//! This holds resources; it does not dispatch container or protected effects.
use super::*;
use crate::reservation_gate::{AdmissionBounds, OrdinaryLaunchAdmission};
use reverie_contracts::worker_launch::WorkerRequest;
use reverie_host::worker_reports::{
    AcceptedWorkerConnection, WorkerLaunchConnection, WorkerReportError,
};
use std::{os::unix::net::UnixStream, time::Instant};
mod error;
mod preparation;
pub(in crate::installing_broker) mod service;
pub(in crate::installing_broker) use preparation::StartedLaptop;
mod viewer;
pub use error::{LaunchAdmissionFailure, WorkerDispatchError};
pub use preparation::{
    AllocationClosedCold, AllocationClosedReuse, ClassifiedWorkerLaunch, ColdFinalizationFailure,
    ColdHandlerClosed, ColdLaunchFailure, ColdViewerFailure, ColdWorkerLaunch, ExistingColdTarget,
    InspectedWorkerLaunch, PreparationFailure as LaunchPreparationFailure, PreparedReuseViewer,
    RestoredReuse, ReusableWorkerLaunch, ReuseFinalizationFailure, ReuseHandlerClosed,
    ReuseViewerFailure, ViewingCold, ViewingReuse,
};
pub use viewer::{ColdRelayReturned, ReuseRelayError, ReuseRelayReturned, WorkerViewerRelayError};
#[cfg(test)]
mod tests;

pub enum WorkerConnectionDispatch<'a> {
    ReportCompleted,
    Launch(ReceivedWorkerLaunch<'a>),
}
/// Only the actual same-service accepted socket produces this owner. A request
/// or configuration value cannot create one, and it cannot outlive its broker.
#[must_use = "retain the accepted connection through checked handler close"]
pub struct ReceivedWorkerLaunch<'a> {
    broker: &'a InstallingBroker,
    connection: Arc<WorkerLaunchConnection>,
}
#[must_use = "close the actual admission and connection, not just request data"]
pub struct AdmittedWorkerLaunch<'a> {
    request: ReceivedWorkerLaunch<'a>,
    snapshot: Arc<ValidatedWorkerSnapshot>,
    admission: Option<OrdinaryLaunchAdmission>,
}
impl InstallingBroker {
    /// Fixed T/J dispatch only. Register the real socket before parsing; UID
    /// precedes frame/collector access. Both purposes use the same actual
    /// maxWorkers+4 registry and Runtime captured at installing bootstrap.
    pub fn accept_worker_connection(
        &self,
        stream: UnixStream,
    ) -> Result<WorkerConnectionDispatch<'_>, WorkerDispatchError> {
        let registered = self.reports.register_worker_connection(stream)?;
        self.accept_registered_worker_connection(registered)
    }
    pub(crate) fn accept_registered_worker_connection(
        &self,
        mut registered: reverie_host::worker_reports::RegisteredWorkerConnection,
    ) -> Result<WorkerConnectionDispatch<'_>, WorkerDispatchError> {
        if !registered.same_runtime(&self.storage.runtime) {
            let cleanup = registered.close().err();
            return Err(WorkerDispatchError::Configuration {
                primary: GateError::Refused("WORKER_HANDLER_RUNTIME_CHANGED"),
                cleanup,
            });
        }
        if let Err(primary) = registered.await_handler_publication() {
            let cleanup = registered.close();
            let error = match cleanup {
                Ok(()) => primary,
                Err(secondary) => WorkerReportError::Finalization {
                    primary: Box::new(primary),
                    secondary: Box::new(secondary),
                },
            };
            return Err(error.into());
        }
        let snapshot = match self.configuration() {
            Ok(snapshot) => snapshot,
            Err(primary) => {
                let cleanup = registered.close().err();
                return Err(WorkerDispatchError::Configuration { primary, cleanup });
            }
        };
        match registered.receive(self.command_telemetry(), snapshot.configuration())? {
            AcceptedWorkerConnection::ReportCompleted => {
                Ok(WorkerConnectionDispatch::ReportCompleted)
            }
            AcceptedWorkerConnection::Launch(connection) => {
                Ok(WorkerConnectionDispatch::Launch(ReceivedWorkerLaunch {
                    broker: self,
                    connection: Arc::new(connection),
                }))
            }
        }
    }
}
impl<'a> ReceivedWorkerLaunch<'a> {
    pub fn request(&self) -> &WorkerRequest {
        self.connection.request()
    }
    pub fn close(&self, end: Instant) -> Result<(), WorkerReportError> {
        // Physical connection close is not lifecycle-hold/capacity settlement.
        self.connection.close_socket(end).map(|_| ())
    }
    pub(crate) fn close_for_worker(&self) -> Result<(), WorkerReportError> {
        self.connection.close_socket_for_worker().map(|_| ())
    }
    /// Original ordinary prefix: actual validated J -> image refresh -> queued
    /// GPU cold boundary for non-attach -> actual captured optional admission.
    /// Protected L joins are deliberately not selected by a J request/DTO.
    pub fn begin_ordinary(
        self,
    ) -> Result<AdmittedWorkerLaunch<'a>, Box<LaunchAdmissionFailure<'a>>> {
        let result = self.enter();
        match result {
            Ok((snapshot, admission)) => Ok(AdmittedWorkerLaunch {
                request: self,
                snapshot,
                admission,
            }),
            Err(cause) => Err(Box::new(LaunchAdmissionFailure {
                request: self,
                cause,
            })),
        }
    }
    fn enter(
        &self,
    ) -> Result<
        (
            Arc<ValidatedWorkerSnapshot>,
            Option<OrdinaryLaunchAdmission>,
        ),
        WorkerDispatchError,
    > {
        self.connection.assert_ordinary_origin()?;
        self.connection.assert_open(&self.broker.storage.runtime)?;
        self.broker.refresh_launch_configuration()?;
        if self.request().attach_only() != Some(true) {
            self.broker.gpu_cold_boundary(self.request().session())?;
        }
        // Capture after GPU's possible real publication, before acquiring the
        // admission so no later fallible RAM read drops a partial scope.
        let snapshot = self.broker.configuration()?;
        let admission = self
            .broker
            .resource_reservations()?
            .map(|gate| {
                gate.admit_ordinary_launch(self.request().session(), AdmissionBounds::default())
            })
            .transpose()?;
        Ok((snapshot, admission))
    }
}
impl AdmittedWorkerLaunch<'_> {
    pub(super) fn lifecycle_connection(
        &self,
        lifecycle: &LaptopLifecycle<'_>,
    ) -> Result<Arc<WorkerLaunchConnection>, GateError> {
        if !lifecycle.belongs_to(&self.request.broker.installed) {
            return Err(GateError::Refused("WORKER_BROKER_ACTIVE_ORIGIN"));
        }
        self.request
            .connection
            .assert_open(&self.request.broker.storage.runtime)
            .map_err(|_| GateError::Refused("WORKER_LAUNCH_CONNECTION_CHANGED"))?;
        Ok(self.request.connection.clone())
    }
    pub fn request(&self) -> &WorkerRequest {
        self.request.request()
    }
    pub fn configuration(&self) -> &ValidatedWorkerSnapshot {
        &self.snapshot
    }
    /// This prefix has performed no container effect. Consume only its actual
    /// allocation scope/socket; no storage/laptop/global release is claimed.
    pub fn close(mut self, end: Instant) -> Result<(), WorkerDispatchError> {
        let admission = self
            .admission
            .take()
            .map(OrdinaryLaunchAdmission::close)
            .transpose();
        let transport = self.request.close(end);
        match (admission, transport) {
            (Ok(_), Ok(())) => Ok(()),
            (Err(primary), cleanup) => Err(WorkerDispatchError::Finalization {
                primary,
                cleanup: cleanup.err(),
            }),
            (Ok(_), Err(error)) => Err(error.into()),
        }
    }
}
impl Drop for ReceivedWorkerLaunch<'_> {
    fn drop(&mut self) {
        // A retained active reference does not keep a dead handler's socket
        // usable. Checked-close uncertainty stays in the original service;
        // active/pending and actual storage/Nix/Office owners settle separately.
        let _ = self.connection.close_socket(Instant::now());
    }
}
