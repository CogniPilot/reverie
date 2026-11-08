//! Fixed service-owned detached-seat cleanup. No C frame, global drain or
//! authority is reconstructed from SID/status DATA.
use super::*;
use crate::reservation_gate::FleetStopAdmission;
use reverie_contracts::worker_config::EffectiveWorkerConfig;
use std::{
    fmt,
    time::{Duration, Instant},
};

#[derive(Debug)]
enum Cause {
    Gate(GateError),
    Storage(StorageWorkflowError),
    Network(storage::NetworkStorageError),
    Refused(&'static str),
}
impl fmt::Display for Cause {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Gate(error) => error.fmt(out),
            Self::Storage(error) => error.fmt(out),
            Self::Network(error) => error.fmt(out),
            Self::Refused(error) => out.write_str(error),
        }
    }
}
impl From<GateError> for Cause {
    fn from(error: GateError) -> Self {
        Self::Gate(error)
    }
}
impl From<StorageWorkflowError> for Cause {
    fn from(error: StorageWorkflowError) -> Self {
        Self::Storage(error)
    }
}

struct Attempt {
    broker: Arc<InstallingBroker>,
    admission: Option<FleetStopAdmission>,
    original: Option<LaptopRegistration>,
    loose: Option<StorageClaim>,
    office: Option<Arc<recovered::RecoveredOffice>>,
    seat: Option<seat_stop::SeatStop>,
    token: Option<lifecycle::DetachedStopToken>,
    end: Instant,
    cause: Option<Cause>,
    finished: bool,
}
/// Stored only on the original service thread, outside InstallingBroker's Arc.
pub(super) struct DetachedStopFailure {
    owner: Option<Box<Attempt>>,
}
impl fmt::Display for DetachedStopFailure {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.owner
            .as_ref()
            .expect("retained original")
            .cause
            .as_ref()
            .expect("original cause")
            .fmt(out)
    }
}
impl DetachedStopFailure {
    /// Only the SAME already-issued native work; never repeat the stop body.
    pub(super) fn settle_native(&mut self) -> Result<(), StorageWorkflowError> {
        let owner = self.owner.as_mut().expect("retained original");
        owner
            .seat
            .as_ref()
            .map_or(Ok(()), |seat| seat.settle(owner.end))
    }
}
impl Drop for DetachedStopFailure {
    fn drop(&mut self) {
        if let Some(owner) = self.owner.take() {
            std::mem::forget(owner);
        }
    }
}
impl InstallingBroker {
    pub(super) fn supervise_detached(self: &Arc<Self>) -> Result<(), DetachedStopFailure> {
        let mut owner = Box::new(Attempt {
            broker: self.clone(),
            admission: None,
            original: None,
            loose: None,
            office: None,
            seat: None,
            token: None,
            end: Instant::now() + Duration::from_secs(20),
            cause: None,
            finished: false,
        });
        match owner.run() {
            Ok(()) => {
                owner.finished = true;
                Ok(())
            }
            Err(cause) => {
                owner.cause = Some(cause);
                Err(DetachedStopFailure { owner: Some(owner) })
            }
        }
    }
}
impl Attempt {
    fn run(&mut self) -> Result<(), Cause> {
        let broker = self.broker.clone();
        let snapshot = broker.configuration()?;
        let candidate = {
            let Some(lifecycle) = broker.installed.try_supervisor_lifecycle()? else {
                return Ok(());
            };
            let mut selected = None;
            for entry in lifecycle.guard.iter() {
                if lifecycle.supervisor_detached(&entry.session)
                    && should_stop(&broker, entry, snapshot.configuration())?
                {
                    selected = Some((entry.session.clone(), entry.name.clone()));
                    break;
                }
            }
            selected
        };
        let Some((session, target)) = candidate else {
            return Ok(());
        };
        if let Some(gate) = broker.resource_reservations()? {
            let Some(admission) = gate.try_admit_service_stop(
                &broker.installed,
                &broker.storage.runtime.stop_budget(),
                &target,
                self.end,
            )?
            else {
                return Ok(());
            };
            self.admission = Some(admission);
        } else if reverie_contracts::worker_validation::WorkerValidationData::new(
            snapshot.configuration(),
        )
        .reservation()
        .map_err(GateError::from)?
        .is_some()
        {
            return Err(Cause::Refused(
                "RESERVATION_INSTALL_REQUIRES_RECONCILIATION",
            ));
        }
        let Some(mut lifecycle) = broker.installed.try_supervisor_lifecycle()? else {
            return self.close_admission();
        };
        let source = broker.configuration()?;
        let entry = lifecycle
            .guard
            .iter()
            .find(|entry| entry.session == session);
        if !lifecycle.supervisor_detached(&session)
            || entry.is_none_or(|entry| entry.name != target)
            || !should_stop(
                &broker,
                entry.expect("current registration"),
                source.configuration(),
            )?
        {
            return self.close_admission();
        }
        let (entry, token) = lifecycle.take_supervisor_stop(&session)?;
        self.original = Some(entry);
        self.token = Some(token);
        self.prepare(source.configuration())?;
        self.seat.as_ref().expect("actual stop owner").stop()?;
        self.seat
            .as_mut()
            .expect("same stop owner")
            .finish(self.end)?;
        self.close_admission()?;
        lifecycle.finish_supervisor_stop(self.token.as_ref().expect("same pending token"))?;
        self.token = None;
        self.original = None;
        Ok(())
    }
    fn close_admission(&mut self) -> Result<(), Cause> {
        if let Some(admission) = self.admission.take() {
            admission.close()?;
        }
        Ok(())
    }
    fn prepare(&mut self, source: &EffectiveWorkerConfig) -> Result<(), Cause> {
        if Instant::now() >= self.end || self.broker.storage.runtime.cancellation().is_cancelled() {
            return Err(Cause::Refused("WORKER_SUPERVISOR_STOP_DEADLINE"));
        }
        let entry = self.original.as_ref().expect("actual removed registration");
        match &entry.owner {
            LaptopOwner::Started(owner) => {
                let stop = self
                    .broker
                    .storage
                    .retain_started_control_stop(owner, source, self.end)?;
                self.seat = Some(seat_stop::SeatStop {
                    stop: Some(stop),
                    claim: None,
                    office: Some(owner.office.clone()),
                });
                return Ok(());
            }
            LaptopOwner::Recovered(_) => {}
            #[cfg(test)]
            LaptopOwner::Modeled => return Err(Cause::Refused("WORKER_MODELED_STOP_REFUSED")),
        }
        let entry = self.original.take().expect("same recovered registration");
        let LaptopOwner::Recovered(owner) = entry.owner else {
            unreachable!();
        };
        self.loose = Some(owner.storage);
        self.office = Some(owner.office);
        let claim = self.loose.take().expect("same original claim");
        match claim.into_control_stop(source, self.end) {
            Ok(stop) => {
                self.seat = Some(seat_stop::SeatStop {
                    stop: Some(stop),
                    claim: None,
                    office: self.office.take(),
                })
            }
            Err(failure) => {
                let (claim, cause) = *failure;
                self.loose = Some(claim);
                return Err(cause.into());
            }
        }
        Ok(())
    }
}
impl Drop for Attempt {
    fn drop(&mut self) {
        if !self.finished {
            std::mem::forget((
                self.broker.clone(),
                self.admission.take(),
                self.original.take(),
                self.loose.take(),
                self.office.take(),
                self.seat.take(),
                self.token.take(),
                self.cause.take(),
            ));
        }
    }
}
fn should_stop(
    broker: &InstallingBroker,
    entry: &LaptopRegistration,
    source: &EffectiveWorkerConfig,
) -> Result<bool, Cause> {
    let (paths, completed) = match &entry.owner {
        LaptopOwner::Started(owner) => (
            owner.network.paths(),
            owner
                .network
                .created_completed(&owner.created)
                .map_err(Cause::Network)?,
        ),
        LaptopOwner::Recovered(owner) => (
            owner.storage.paths(),
            owner
                .storage
                .observe_launch_receipt()?
                .recheck_is_file(&broker.storage.runtime)
                .map_err(StorageWorkflowError::from)?,
        ),
        #[cfg(test)]
        LaptopOwner::Modeled => return Err(Cause::Refused("WORKER_MODELED_STOP_REFUSED")),
    };
    let settings =
        reverie_contracts::resource_config::ResourceIdentitySettings::capture_worker_config(source)
            .map_err(reverie_host::worker_storage::StorageOwnerError::Settings)
            .map_err(StorageWorkflowError::from)?;
    let identity =
        reverie_store::storage_identity::StorageIdentityConfig::capture_worker_settings(&settings);
    let current = reverie_store::storage_identity::storage_start_allowed(&identity, paths)
        .map_err(reverie_host::worker_storage::StorageOwnerError::Identity)
        .map_err(StorageWorkflowError::from)?;
    Ok(completed || !current || !broker.allowed(&entry.session)?)
}
