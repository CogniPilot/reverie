//! The single installing lifecycle state. Native operations and resource
//! settlement stay with their actual owners; membership is never a stop grant.
use super::*;
use reverie_host::worker_reports::{WorkerLaunchConnection, WorkerLaunchHold};
use std::ops::{Deref, DerefMut};

/// Only equality with the same installed state has meaning. This is not wire
/// data or permission. Keeping the Arc prevents address reuse while observed.
#[derive(Clone)]
pub(super) struct LaunchGeneration(Arc<()>);
struct ActiveLaunch {
    session: ProfileSessionId,
    identity: Arc<()>,
    connection: Arc<WorkerLaunchConnection>,
}
struct PendingName {
    session: ProfileSessionId,
    name: WorkerContainerName,
    identity: Arc<()>,
}
pub(super) struct LaptopState {
    committed: Vec<LaptopRegistration>,
    active: Vec<ActiveLaunch>,
    pending: Vec<PendingName>,
    generation: LaunchGeneration,
    draining: bool,
}
impl LaptopState {
    pub(super) fn new() -> Self {
        Self {
            committed: Vec::new(),
            active: Vec::new(),
            pending: Vec::new(),
            generation: LaunchGeneration(Arc::new(())),
            draining: false,
        }
    }
    pub(super) fn transients_empty(&self) -> bool {
        self.active.is_empty() && self.pending.is_empty()
    }
    pub(super) fn has_pending(&self) -> bool {
        !self.pending.is_empty()
    }
}
// Existing actual Recovered/Source readers keep their committed-owner view.
// Pending names are deliberately not manufactured LaptopOwner variants.
impl Deref for LaptopState {
    type Target = Vec<LaptopRegistration>;
    fn deref(&self) -> &Self::Target {
        &self.committed
    }
}
impl DerefMut for LaptopState {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.committed
    }
}
impl<'a> IntoIterator for &'a LaptopState {
    type Item = &'a LaptopRegistration;
    type IntoIter = std::slice::Iter<'a, LaptopRegistration>;
    fn into_iter(self) -> Self::IntoIter {
        self.committed.iter()
    }
}
pub(crate) struct LaptopLifecycle<'a> {
    pub(super) owner: &'a InstalledWorker,
    pub(super) guard: MutexGuard<'a, LaptopState>,
}
/// The actual accepted connection is shared, not reconstructed or duplicated.
/// This token can only remove/revalidate its exact private registration.
pub(super) struct ActiveLaunchToken<'a> {
    owner: &'a InstalledWorker,
    session: ProfileSessionId,
    identity: Arc<()>,
    connection: Arc<WorkerLaunchConnection>,
    hold: WorkerLaunchHold,
}
impl InstalledWorker {
    pub(super) fn capture_generation(&self) -> Result<LaunchGeneration, GateError> {
        Ok(self.lifecycle()?.guard.generation.clone())
    }
}
impl<'a> LaptopLifecycle<'a> {
    pub(crate) fn belongs_to(&self, owner: &InstalledWorker) -> bool {
        std::ptr::eq(self.owner, owner)
    }
    /// Match the original dict's first insertion order when a pending launch
    /// replaces an existing SID's name, and append genuinely new pending SIDs.
    pub(crate) fn entries(
        &self,
    ) -> impl Iterator<Item = (&ProfileSessionId, &WorkerContainerName)> {
        self.guard
            .committed
            .iter()
            .map(|entry| {
                let name = self
                    .guard
                    .pending
                    .iter()
                    .find(|p| p.session == entry.session)
                    .map_or(&entry.name, |pending| &pending.name);
                (&entry.session, name)
            })
            .chain(
                self.guard
                    .pending
                    .iter()
                    .filter(|p| {
                        !self
                            .guard
                            .committed
                            .iter()
                            .any(|entry| entry.session == p.session)
                    })
                    .map(|pending| (&pending.session, &pending.name)),
            )
    }
    /// This state check is only one part of wait_current. The real preparation
    /// also checks original config/wait-binding and the same Runtime stop state.
    pub(super) fn check_generation(&self, generation: &LaunchGeneration) -> Result<(), GateError> {
        if self.guard.draining || !Arc::ptr_eq(&self.guard.generation.0, &generation.0) {
            return Err(GateError::Refused("WORKER_LAUNCH_GENERATION_CHANGED"));
        }
        Ok(())
    }
    /// Caller holds actual admission, has acquired the actual StorageClaim,
    /// and has performed its late allowed() read under this same lifecycle.
    /// Complete all fallible checks/reservations before the paired insertion.
    pub(super) fn claim_active(
        &mut self,
        generation: &LaunchGeneration,
        context: &launch::AdmittedWorkerLaunch<'_>,
        preparation_hold: &mut Option<WorkerLaunchHold>,
    ) -> Result<ActiveLaunchToken<'a>, GateError> {
        let connection = self.active_connection(generation, context)?;
        connection
            .assert_lifecycle_hold(preparation_hold.as_ref().ok_or(GateError::Refused(
                "WORKER_BROKER_PREPARATION_HOLD_REQUIRED",
            ))?)
            .map_err(|_| GateError::Refused("WORKER_BROKER_PREPARATION_HOLD_CHANGED"))?;
        let session = context.request().session();
        let name =
            WorkerContainerName::for_session(context.configuration().envelope().base(), session);
        let identity = Arc::new(());
        self.guard
            .active
            .try_reserve(1)
            .map_err(|_| GateError::Refused("WORKER_BROKER_ACTIVE_UNAVAILABLE"))?;
        self.guard
            .pending
            .try_reserve(1)
            .map_err(|_| GateError::Refused("WORKER_BROKER_ACTIVE_UNAVAILABLE"))?;
        // The genuine preparation minted this BEFORE its first storage claim.
        // Every fallible check/allocation is complete before moving it. No
        // second mint or identity reconstruction occurs at active insertion.
        let hold = preparation_hold
            .take()
            .expect("checked actual preparation hold");
        self.guard.active.push(ActiveLaunch {
            session: session.clone(),
            identity: identity.clone(),
            connection: connection.clone(),
        });
        self.guard.pending.push(PendingName {
            session: session.clone(),
            name,
            identity: identity.clone(),
        });
        Ok(ActiveLaunchToken {
            owner: self.owner,
            session: session.clone(),
            identity,
            connection,
            hold,
        })
    }
    /// The original attached/generation refusal precedes the late allowed()
    /// read under the same held lifecycle. This observation grants no effect.
    pub(super) fn check_active_available(
        &self,
        generation: &LaunchGeneration,
        context: &launch::AdmittedWorkerLaunch<'_>,
    ) -> Result<(), GateError> {
        self.active_connection(generation, context).map(|_| ())
    }
    fn active_connection(
        &self,
        generation: &LaunchGeneration,
        context: &launch::AdmittedWorkerLaunch<'_>,
    ) -> Result<Arc<WorkerLaunchConnection>, GateError> {
        let connection = context.lifecycle_connection(self)?;
        self.check_generation(generation)?;
        let session = context.request().session();
        if self
            .guard
            .active
            .iter()
            .any(|entry| &entry.session == session)
        {
            return Err(GateError::Refused(
                "A worker for this session is already attached",
            ));
        }
        if self
            .guard
            .pending
            .iter()
            .any(|entry| &entry.session == session)
        {
            return Err(GateError::Refused("WORKER_BROKER_ACTIVE_UNAVAILABLE"));
        }
        Ok(connection)
    }
    /// Remove only this handler's actual socket/name registrations. No storage,
    /// Office, Nix or committed Recovered/Started ownership is released here.
    pub(super) fn finalize_active(
        &mut self,
        token: &ActiveLaunchToken<'_>,
    ) -> Result<(), GateError> {
        if !self.belongs_to(token.owner) {
            return Err(GateError::Refused("WORKER_BROKER_ACTIVE_ORIGIN"));
        }
        token
            .connection
            .assert_same_lifecycle_record(&token.hold)
            .map_err(|_| GateError::Refused("WORKER_BROKER_PREPARATION_HOLD_CHANGED"))?;
        if self.guard.active.iter().any(|entry| {
            entry.session == token.session
                && (!Arc::ptr_eq(&entry.identity, &token.identity)
                    || !Arc::ptr_eq(&entry.connection, &token.connection))
        }) || self.guard.pending.iter().any(|entry| {
            entry.session == token.session && !Arc::ptr_eq(&entry.identity, &token.identity)
        }) {
            return Err(GateError::Refused("WORKER_BROKER_ACTIVE_CHANGED"));
        }
        self.guard
            .active
            .retain(|entry| !Arc::ptr_eq(&entry.identity, &token.identity));
        self.guard
            .pending
            .retain(|entry| !Arc::ptr_eq(&entry.identity, &token.identity));
        Ok(())
    }
    /// The actual Nix copy released this mutex, never its J, hold or resource.
    /// Rejoin only the original paired entries; missing metadata is not repair.
    pub(super) fn reenter_active(
        &self,
        token: &ActiveLaunchToken<'_>,
        context: &launch::AdmittedWorkerLaunch<'_>,
    ) -> Result<(), GateError> {
        if !self.belongs_to(token.owner) {
            return Err(GateError::Refused("WORKER_BROKER_ACTIVE_ORIGIN"));
        }
        let connection = context.lifecycle_connection(self)?;
        connection
            .assert_same_lifecycle_record(&token.hold)
            .map_err(|_| GateError::Refused("WORKER_BROKER_PREPARATION_HOLD_CHANGED"))?;
        if !Arc::ptr_eq(&connection, &token.connection)
            || context.request().session() != &token.session
            || self
                .guard
                .active
                .iter()
                .filter(|entry| {
                    entry.session == token.session
                        && Arc::ptr_eq(&entry.identity, &token.identity)
                        && Arc::ptr_eq(&entry.connection, &connection)
                })
                .count()
                != 1
            || self
                .guard
                .pending
                .iter()
                .filter(|entry| {
                    entry.session == token.session && Arc::ptr_eq(&entry.identity, &token.identity)
                })
                .count()
                != 1
        {
            return Err(GateError::Refused("WORKER_BROKER_ACTIVE_CHANGED"));
        }
        Ok(())
    }
}

#[cfg(test)]
pub(super) mod fixture_cleanup {
    use super::*;
    /// Owning tests tear down known effect-free synthetic fixtures after their
    /// assertions. This is not a production release contract or a no-op permit.
    pub(in crate::installing_broker) fn release_hold(
        token: &mut ActiveLaunchToken<'_>,
        end: std::time::Instant,
    ) -> Result<(), reverie_host::worker_reports::WorkerReportError> {
        token.hold.release(end)
    }
}
