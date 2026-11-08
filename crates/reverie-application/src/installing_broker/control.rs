//! Actual legacy C stop-laptops consumer. It grants no pool administration.
use super::*;
use crate::reservation_gate::FleetStopAdmission;
use reverie_contracts::worker_control::WorkerControlRequest;
use reverie_host::{
    worker_reports::{
        WorkerLaunchClose, WorkerLaunchHold, WorkerServiceConnection, WorkerServicePurpose,
    },
    worker_source_stop::{ControlStopCensus, SourceStopError},
};
use std::{
    fmt,
    time::{Duration, Instant},
};
#[cfg(test)]
mod tests;

#[derive(Debug)]
enum Cause {
    Gate(GateError),
    Storage(StorageWorkflowError),
    Native(SourceStopError),
    Report(reverie_host::worker_reports::WorkerReportError),
    Refused(&'static str),
}
impl fmt::Display for Cause {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Gate(e) => e.fmt(out),
            Self::Storage(e) => e.fmt(out),
            Self::Native(e) => e.fmt(out),
            Self::Report(e) => e.fmt(out),
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

struct Seat {
    stop: Option<storage::ControlStorageStop>,
    claim: Option<StorageClaim>,
    office: Option<Arc<recovered::RecoveredOffice>>,
}
struct Frame<'a> {
    broker: &'a Arc<InstallingBroker>,
    connection: WorkerServiceConnection,
    hold: Option<WorkerLaunchHold>,
    admission: Option<FleetStopAdmission>,
    drain: Option<lifecycle::DrainingOwner>,
    census: Option<ControlStopCensus>,
    originals: Vec<LaptopRegistration>,
    loose: Option<StorageClaim>,
    seats: Vec<Seat>,
    end: Instant,
    sessions: Vec<ProfileSessionId>,
    orphan_offices: Vec<Arc<recovered::RecoveredOffice>>,
    completed: bool,
    finalization_failed: bool,
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
            hold: None,
            admission: None,
            drain: None,
            census: None,
            originals: Vec::new(),
            loose: None,
            seats: Vec::new(),
            end: Instant::now() + Duration::from_secs(120),
            sessions: Vec::new(),
            orphan_offices: Vec::new(),
            completed: false,
            finalization_failed: false,
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
        WorkerControlRequest::decode(self.connection.request_bytes()).map_err(Cause::Refused)?;
        self.hold = Some(self.connection.retain_lifecycle()?);
        let snapshot = self.broker.configuration()?;
        self.admission = self
            .broker
            .resource_reservations()?
            .map(|gate| {
                gate.admit_fleet_stop(
                    &self.broker.installed,
                    &self.broker.storage.runtime.stop_budget(),
                )
            })
            .transpose()?;
        let mut lifecycle = self.broker.installed.lifecycle()?;
        // Exact original J owners must finish before C can consume idle storage.
        if !lifecycle.guard.transients_empty() {
            return Err(Cause::Refused("WORKER_STOP_ACTIVE_LAUNCH_OR_VIEWER"));
        }
        self.census = Some(
            self.broker
                .storage
                .runtime
                .control_stop_census(snapshot.envelope().base(), self.end)?,
        );
        let census = self
            .census
            .as_mut()
            .expect("retained census")
            .read(&self.broker.storage.runtime)?;
        for (_, name) in census.entries() {
            if let Some(admission) = &self.admission {
                admission.check_target(name)?;
            }
        }
        for entry in lifecycle.guard.iter() {
            if let Some(admission) = &self.admission {
                admission.check_target(&entry.name)?;
            }
        }
        self.drain = Some(lifecycle.begin_control_drain()?);
        self.originals = std::mem::take(&mut **lifecycle.guard);
        self.prepare_registered(snapshot.configuration())?;
        for (sid, _) in census.entries() {
            // Registered seats were selected from the original registry; only
            // genuinely detached names need a fresh actual lease acquisition.
            if self.sessions.contains(sid) {
                continue;
            }
            self.loose = Some(self.broker.storage.claim(snapshot.configuration(), sid)?);
            self.prepare_loose(snapshot.configuration(), None)?;
        }
        for seat in &self.seats {
            seat.stop.as_ref().expect("actual stop owner").stop()?;
        }
        if !self
            .census
            .as_mut()
            .expect("same census")
            .read(&self.broker.storage.runtime)?
            .entries()
            .is_empty()
        {
            return Err(Cause::Refused("WORKER_STOP_RUNNING_REMAIN"));
        }
        self.finish_seats()?;
        if let Some(admission) = self.admission.take()
            && let Err(cause) = admission.close()
        {
            self.finalization_failed = true;
            return Err(cause.into());
        }
        lifecycle.finish_control_drain(self.drain.as_ref().expect("actual drain"))?;
        self.drain = None;
        self.connection
            .reply_json(br#"{"action":"stop-laptops","success":true}"#)?;
        self.close_transport()?;
        self.completed = true;
        Ok(())
    }
    fn prepare_registered(
        &mut self,
        source: &reverie_contracts::worker_config::EffectiveWorkerConfig,
    ) -> Result<(), Cause> {
        while let Some(entry) = self.originals.pop() {
            self.prepare_registered_entry(entry, source)?;
        }
        Ok(())
    }
    fn prepare_registered_entry(
        &mut self,
        entry: LaptopRegistration,
        source: &reverie_contracts::worker_config::EffectiveWorkerConfig,
    ) -> Result<(), Cause> {
        self.sessions.push(entry.session.clone());
        match entry.owner {
            LaptopOwner::Recovered(owner) => {
                self.loose = Some(owner.storage);
                self.prepare_loose(source, Some(owner.office))?;
            }
            LaptopOwner::Started(owner) => {
                match self
                    .broker
                    .storage
                    .retain_started_control_stop(&owner, source, self.end)
                {
                    Ok(stop) => self.seats.push(Seat {
                        stop: Some(stop),
                        claim: None,
                        office: Some(owner.office.clone()),
                    }),
                    Err(cause) => {
                        self.originals.push(LaptopRegistration {
                            owner: LaptopOwner::Started(owner),
                            ..entry
                        });
                        return Err(cause.into());
                    }
                }
            }
            #[cfg(test)]
            LaptopOwner::Modeled => {
                self.originals.push(entry);
                return Err(Cause::Refused("WORKER_MODELED_STOP_REFUSED"));
            }
        }
        Ok(())
    }
    fn prepare_loose(
        &mut self,
        source: &reverie_contracts::worker_config::EffectiveWorkerConfig,
        office: Option<Arc<recovered::RecoveredOffice>>,
    ) -> Result<(), Cause> {
        let claim = self.loose.take().expect("same actual claim");
        match claim.into_control_stop(source, self.end) {
            Ok(stop) => {
                self.seats.push(Seat {
                    stop: Some(stop),
                    claim: None,
                    office,
                });
                Ok(())
            }
            Err(failure) => {
                let (claim, cause) = *failure;
                self.loose = Some(claim);
                if let Some(office) = office {
                    self.orphan_offices.push(office);
                }
                Err(cause.into())
            }
        }
    }
    fn finish_seats(&mut self) -> Result<(), Cause> {
        for seat in &mut self.seats {
            if let Some(office) = &seat.office {
                office
                    .close_for_stopped_source(self.end)
                    .map_err(StorageWorkflowError::from)?;
            }
            let stop = seat.stop.take().expect("actual stopped owner");
            match stop.reclaim(self.end) {
                Ok(claim) => seat.claim = Some(claim),
                Err(failure) => {
                    let (stop, cause) = *failure;
                    seat.stop = Some(stop);
                    return Err(cause.into());
                }
            }
            let claim = seat.claim.take().expect("same reclaimed Box");
            if let Err(failure) = claim.release(self.end) {
                let (claim, cause) = failure.into_parts();
                seat.claim = Some(claim);
                return Err(cause.into());
            }
        }
        Ok(())
    }
    fn close_transport(&mut self) -> Result<(), Cause> {
        self.connection.close_socket_for_worker()?;
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
    pub(in crate::installing_broker) fn reconcile(&mut self) -> bool {
        let Some(owner) = self.owner.as_mut() else {
            return true;
        };
        let runtime = &owner.broker.storage.runtime;
        let mut known = !owner.finalization_failed;
        if let Some(census) = &mut owner.census
            && let Err(cause) = census.settle(runtime, owner.end)
        {
            known = false;
            self.causes.push(cause.into());
        }
        for seat in &owner.seats {
            if let Some(stop) = &seat.stop
                && let Err(cause) = stop.settle(owner.end)
            {
                known = false;
                self.causes.push(cause.into());
            }
        }
        // Native call settlement alone never forgives a failed physical stop,
        // restores consumed resources, clears draining or releases admission.
        if !known
            || owner.drain.is_some()
            || !owner.seats.is_empty()
            || !owner.originals.is_empty()
            || owner.loose.is_some()
        {
            return false;
        }
        if let Some(admission) = owner.admission.take()
            && let Err(cause) = admission.abort()
        {
            owner.finalization_failed = true;
            self.causes.push(cause.into());
            return false;
        }
        match owner.close_transport() {
            Ok(()) => {
                owner.completed = true;
                self.owner = None;
                true
            }
            Err(cause) => {
                self.causes.push(cause);
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
                self.admission.take(),
                self.hold.take(),
                self.census.take(),
                self.loose.take(),
                std::mem::take(&mut self.originals),
                std::mem::take(&mut self.seats),
                std::mem::take(&mut self.orphan_offices),
            ));
        }
    }
}
