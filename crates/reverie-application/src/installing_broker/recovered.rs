//! Actual running-laptop recovery transaction. Name membership remains DATA;
//! successful registration retains genuine Office and selected storage owners.
use super::*;
use crate::resource_staging;
use reverie_contracts::{
    device_policy::memory, resource_config::checked_effective_policy,
    worker_recovery::RecoveryNames,
};
use reverie_core::resources::BudgetMode;
use reverie_host::{
    office::{OfficePhone, OfficeService},
    worker_storage,
};
use reverie_store::storage_identity::StorageKind;
use std::time::Instant;
mod attempt;
use attempt::Attempt;
mod error;
mod lifetime;
mod service;
#[cfg(test)]
pub(in crate::installing_broker) mod tests;
pub use error::RecoveryError;
type Result<T> = std::result::Result<T, RecoveryError>;

/// Empty until the first actual recovery/new-phone phase. This is lifecycle
/// state, not a disabled substitute for mandatory bootstrap telemetry.
pub(super) struct RecoveryOwners {
    office: Mutex<Option<Arc<OfficeService>>>,
    uncertain: Mutex<Vec<StorageClaim>>,
}
impl RecoveryOwners {
    pub(super) fn new() -> Self {
        Self {
            office: Mutex::new(None),
            uncertain: Mutex::new(Vec::new()),
        }
    }
    pub(super) fn office(
        &self,
        broker: &InstallingBroker,
        snapshot: &ValidatedWorkerSnapshot,
    ) -> Result<Arc<OfficeService>> {
        let mut slot = self
            .office
            .lock()
            .map_err(|_| RecoveryError::Refused("WORKER_OFFICE_REGISTRY_UNAVAILABLE"))?;
        if let Some(service) = &*slot {
            return Ok(service.clone());
        }
        let service = Arc::new(OfficeService::from_worker(
            &broker.storage.runtime,
            snapshot.configuration(),
            broker.command_telemetry().clone(),
        )?);
        *slot = Some(service.clone());
        Ok(service)
    }
    fn retain(&self, claim: StorageClaim) {
        // Poison must never drop the actual unresolved resource owner.
        self.uncertain
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .push(claim);
    }
}
pub(super) struct RecoveredOffice {
    // Retained resources, including after last-broker Drop. Actual structured
    // stop/Office close consumers remain separate from recovery membership.
    pub(super) _phone: OfficePhone,
    pub(super) _office: Arc<OfficeService>,
}
impl RecoveredOffice {
    /// Close this exact recovered phone and its tracked native/request work.
    /// Other phones and the installing Runtime remain live for the target.
    pub(super) fn close_for_stopped_source(
        &self,
        end: std::time::Instant,
    ) -> std::result::Result<(), reverie_host::office::OfficeError> {
        self._office.close_phone(&self._phone, end)
    }
}
pub(super) struct RecoveredLaptop {
    pub(super) office: Arc<RecoveredOffice>,
    pub(super) storage: StorageClaim,
}
pub(super) enum LaptopOwner {
    Recovered(Box<RecoveredLaptop>),
    Started(Arc<super::launch::StartedLaptop>),
    #[cfg(test)]
    Modeled,
}
/// Membership only. No exact CID/process/start or authenticated caller grant
/// is reconstructed by successful native recovery.
pub struct RecoverySummary {
    selected: usize,
    registered: usize,
}
impl RecoverySummary {
    pub fn selected(&self) -> usize {
        self.selected
    }
    pub fn registered(&self) -> usize {
        self.registered
    }
}
impl InstallingBroker {
    /// Called by the real installing service before its listener/supervisor.
    /// Optional reservations remain an actual absence, never a fake Gate.
    pub fn recover_laptops(&self) -> Result<RecoverySummary> {
        let admission = self
            .resource_reservations()?
            .map(ReservationGate::admit_recovery)
            .transpose()?;
        let result = self.recover_running(admission.as_ref());
        match (result, admission) {
            (result, None) => result,
            (Ok(value), Some(admission)) => {
                admission.close()?;
                Ok(value)
            }
            (Err(error), Some(admission)) => match admission.abort() {
                Ok(()) => Err(error),
                Err(cleanup) => Err(error::finalized(error, cleanup.into())),
            },
        }
    }
    fn recover_running(
        &self,
        admission: Option<&crate::reservation_gate::RecoveryAdmission>,
    ) -> Result<RecoverySummary> {
        // Existing source serve performs recovery before publishing its broker
        // listener. This lifecycle owner also excludes a competing publication.
        let mut lifecycle = self.installed.lifecycle()?;
        self.recover_running_locked(&mut lifecycle, admission, None)
    }
    pub(super) fn recover_running_locked(
        &self,
        lifecycle: &mut LaptopLifecycle<'_>,
        admission: Option<&crate::reservation_gate::RecoveryAdmission>,
        end: Option<Instant>,
    ) -> Result<RecoverySummary> {
        if !lifecycle.belongs_to(&self.installed) {
            return Err(RecoveryError::Refused("WORKER_RECOVERY_LIFECYCLE_CHANGED"));
        }
        lifecycle.assert_recoverable()?;
        check_deadline(end)?;
        let snapshot = self.configuration()?;
        let source = snapshot.configuration();
        let runtime = &self.storage.runtime;
        let base = snapshot.envelope().base();
        let census = match end {
            Some(end) => runtime.observe_recovery_names_until(base, end),
            None => runtime.observe_recovery_names(base),
        }?;
        if memory::resource_projection_required(source) {
            for (_, name) in census.names().entries() {
                let row = runtime.inspect_recovery_laptop(&census, name)?;
                crate::worker_recovery::verify_recovered_memory_scoped(
                    runtime, &snapshot, &row, end,
                )?;
            }
        }
        if let Some(admission) = admission {
            for (sid, _) in census.names().entries() {
                admission.check_launch(sid)?;
            }
        }
        let names = merged(lifecycle, census.names());
        check_budget(&snapshot, &names)?;
        let mut attempt = Attempt::new(end);
        let prepared = (|| {
            attempt.prepare(self, &snapshot, census.names(), &names, lifecycle)?;
            if let (Some(_), Some(admission)) = (end, admission) {
                admission.assert_pool_startup_current(&snapshot)?;
            }
            check_deadline(end)
        })();
        if let Err(primary) = prepared {
            return Err(attempt.cleanup(self, primary));
        }
        attempt.register(lifecycle, names);
        Ok(RecoverySummary {
            selected: census.names().entries().len(),
            registered: lifecycle.guard.len(),
        })
    }
}
impl LaptopLifecycle<'_> {
    pub(super) fn assert_recoverable(&self) -> Result<()> {
        // Startup recovery cannot replace a live newly-started SAME-record
        // owner with a reconstructed Direct claim. Its resource borrower is a
        // separate required service consumer, not recovery membership DATA.
        if self
            .guard
            .iter()
            .any(|entry| matches!(entry.owner, LaptopOwner::Started(_)))
        {
            return Err(RecoveryError::Refused(
                "WORKER_RECOVERY_STARTED_RESOURCE_ACTIVE",
            ));
        }
        // This is the actual startup recovery boundary. Hold THIS guard through
        // publication, so no pending J can appear after a separate early check.
        // A tracked pending name is never a recovered storage/Office owner.
        if self.guard.has_pending() {
            return Err(RecoveryError::Refused("WORKER_RECOVERY_LAUNCH_IN_PROGRESS"));
        }
        #[cfg(test)]
        if self
            .guard
            .iter()
            .any(|entry| matches!(&entry.owner, LaptopOwner::Modeled))
        {
            return Err(RecoveryError::Refused(
                "WORKER_MODELED_REGISTRATION_IS_NOT_RECOVERY_OWNER",
            ));
        }
        Ok(())
    }
}
pub(super) fn check_deadline(end: Option<Instant>) -> Result<()> {
    if end.is_some_and(|end| Instant::now() >= end) {
        return Err(RecoveryError::Refused("WORKER_RECOVERY_DEADLINE"));
    }
    Ok(())
}
fn merged(
    lifecycle: &LaptopLifecycle<'_>,
    selected: &RecoveryNames,
) -> Vec<(ProfileSessionId, WorkerContainerName)> {
    let mut names = lifecycle
        .entries()
        .map(|(sid, name)| (sid.clone(), name.clone()))
        .collect::<Vec<_>>();
    for (sid, name) in selected.entries() {
        if let Some(existing) = names.iter_mut().find(|(other, _)| other == sid) {
            existing.1 = name.clone();
        } else {
            names.push((sid.clone(), name.clone()));
        }
    }
    names
}
fn check_budget(
    snapshot: &ValidatedWorkerSnapshot,
    names: &[(ProfileSessionId, WorkerContainerName)],
) -> Result<()> {
    let base = snapshot.envelope().base();
    if names.len() > usize::from(base.max_workers()) {
        return Err(RecoveryError::Refused("WORKER_RECOVERY_ADMISSION_BUDGET"));
    }
    if base.resources().budget_mode() != BudgetMode::Admission {
        return Ok(());
    }
    let mut memory = 0u64;
    for (sid, _) in names {
        let first = resource_staging::effective_config(snapshot.configuration().clone(), sid)?;
        if checked_effective_policy(&first)?.budget_mode() == BudgetMode::Admission {
            // This second real resolver call is intentional source ordering;
            // never cache or merge it with the preceding condition read.
            let second = resource_staging::effective_config(snapshot.configuration().clone(), sid)?;
            memory += u64::from(checked_effective_policy(&second)?.memory_mib());
        }
    }
    if memory > u64::from(base.resources().pool_memory_mib()) {
        return Err(RecoveryError::Refused("WORKER_RECOVERY_ADMISSION_BUDGET"));
    }
    Ok(())
}
