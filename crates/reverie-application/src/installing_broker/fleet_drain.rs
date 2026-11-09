//! Original C stop resources shared with the separately authorized fleet owner.
//! Construction supplies no effect, admission or pool capability.
use super::seat_stop::SeatStop as Seat;
use super::*;
use crate::reservation_gate::FleetStopAdmission;
use reverie_host::worker_source_stop::{ControlStopCensus, SourceStopError};
use std::time::Instant;

#[derive(Debug)]
pub(super) enum DrainCause {
    Gate(GateError),
    Storage(StorageWorkflowError),
    Native(SourceStopError),
    Refused(&'static str),
    Finalization {
        primary: Box<Self>,
        secondary: Box<Self>,
    },
}
impl std::fmt::Display for DrainCause {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Gate(e) => e.fmt(out),
            Self::Storage(e) => e.fmt(out),
            Self::Native(e) => e.fmt(out),
            Self::Refused(e) => out.write_str(e),
            Self::Finalization { primary, secondary } => {
                write!(out, "{primary}; cleanup: {secondary}")
            }
        }
    }
}
impl From<GateError> for DrainCause {
    fn from(e: GateError) -> Self {
        Self::Gate(e)
    }
}
impl From<StorageWorkflowError> for DrainCause {
    fn from(e: StorageWorkflowError) -> Self {
        Self::Storage(e)
    }
}
impl From<SourceStopError> for DrainCause {
    fn from(e: SourceStopError) -> Self {
        Self::Native(e)
    }
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum Stage {
    Ready,
    Attempted,
    Closed,
}

pub(super) struct LegacyFleetDrain<'a> {
    broker: &'a Arc<InstallingBroker>,
    admission: Option<FleetStopAdmission>,
    drain: Option<lifecycle::DrainingOwner>,
    census: Option<ControlStopCensus>,
    originals: Vec<LaptopRegistration>,
    loose: Option<StorageClaim>,
    seats: Vec<Seat>,
    end: Instant,
    sessions: Vec<ProfileSessionId>,
    orphan_offices: Vec<Arc<recovered::RecoveredOffice>>,
    stage: Stage,
    finalization_failed: bool,
}
impl<'a> LegacyFleetDrain<'a> {
    pub(super) fn new(broker: &'a Arc<InstallingBroker>, end: Instant) -> Self {
        Self {
            broker,
            admission: None,
            drain: None,
            census: None,
            originals: Vec::new(),
            loose: None,
            seats: Vec::new(),
            end,
            sessions: Vec::new(),
            orphan_offices: Vec::new(),
            stage: Stage::Ready,
            finalization_failed: false,
        }
    }
    pub(super) fn run_ordinary(&mut self) -> Result<(), DrainCause> {
        if self.stage != Stage::Ready {
            return Err(DrainCause::Refused("WORKER_FLEET_DRAIN_ALREADY_ATTEMPTED"));
        }
        self.stage = Stage::Attempted;
        if Instant::now() >= self.end {
            return Err(DrainCause::Refused("WORKER_FLEET_DRAIN_DEADLINE"));
        }
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
            return Err(DrainCause::Refused("WORKER_STOP_ACTIVE_LAUNCH_OR_VIEWER"));
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
            return Err(DrainCause::Refused("WORKER_STOP_RUNNING_REMAIN"));
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
        self.stage = Stage::Closed;
        Ok(())
    }
    fn prepare_registered(
        &mut self,
        source: &reverie_contracts::worker_config::EffectiveWorkerConfig,
    ) -> Result<(), DrainCause> {
        while let Some(entry) = self.originals.pop() {
            self.prepare_registered_entry(entry, source)?;
        }
        Ok(())
    }
    fn prepare_registered_entry(
        &mut self,
        entry: LaptopRegistration,
        source: &reverie_contracts::worker_config::EffectiveWorkerConfig,
    ) -> Result<(), DrainCause> {
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
                return Err(DrainCause::Refused("WORKER_MODELED_STOP_REFUSED"));
            }
        }
        Ok(())
    }
    fn prepare_loose(
        &mut self,
        source: &reverie_contracts::worker_config::EffectiveWorkerConfig,
        office: Option<Arc<recovered::RecoveredOffice>>,
    ) -> Result<(), DrainCause> {
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
    fn finish_seats(&mut self) -> Result<(), DrainCause> {
        for seat in &mut self.seats {
            seat.finish(self.end)?;
        }
        Ok(())
    }

    pub(super) fn settle_components(&mut self) -> Vec<DrainCause> {
        let runtime = &self.broker.storage.runtime;
        let mut errors = Vec::new();
        if let Some(census) = &mut self.census
            && let Err(cause) = census.settle(runtime, self.end)
        {
            errors.push(cause.into());
        }
        for seat in &self.seats {
            if let Err(cause) = seat.settle(self.end) {
                errors.push(cause.into());
            }
        }
        errors
    }
    pub(super) fn retained(&self) -> bool {
        self.finalization_failed
            || self.drain.is_some()
            || !self.seats.is_empty()
            || !self.originals.is_empty()
            || self.loose.is_some()
    }
    pub(super) fn abort_admission(&mut self) -> Result<(), DrainCause> {
        if self.retained() {
            return Err(DrainCause::Refused("WORKER_STOP_DRAIN_RETAINED"));
        }
        let mut failures = self.settle_components().into_iter();
        if let Some(first) = failures.next() {
            return Err(
                failures.fold(first, |primary, secondary| DrainCause::Finalization {
                    primary: Box::new(primary),
                    secondary: Box::new(secondary),
                }),
            );
        }
        if let Some(admission) = self.admission.take()
            && let Err(cause) = admission.abort()
        {
            self.finalization_failed = true;
            return Err(cause.into());
        }
        self.stage = Stage::Closed;
        Ok(())
    }
}
impl Drop for LegacyFleetDrain<'_> {
    fn drop(&mut self) {
        if self.stage != Stage::Closed {
            std::mem::forget((
                Arc::clone(self.broker),
                self.admission.take(),
                self.census.take(),
                self.loose.take(),
                std::mem::take(&mut self.originals),
                std::mem::take(&mut self.seats),
                std::mem::take(&mut self.orphan_offices),
            ));
        }
    }
}
