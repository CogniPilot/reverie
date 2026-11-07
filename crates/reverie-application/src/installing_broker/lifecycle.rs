//! The single installing lifecycle state. Native operations and resource
//! settlement stay with their actual owners; membership is never a stop grant.
use super::*;
use reverie_host::worker_reports::WorkerLaunchConnection;
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
    generation: LaunchGeneration,
    connection: Arc<WorkerLaunchConnection>,
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
    ) -> Result<ActiveLaunchToken<'a>, GateError> {
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
            generation: generation.clone(),
            connection,
        })
    }
    /// Reentry after unlocked Nix work still requires the real preparation's
    /// current config/intent/storage/writer checks before any further effect.
    pub(super) fn reenter_active(
        &self,
        token: &ActiveLaunchToken<'_>,
        context: &launch::AdmittedWorkerLaunch<'_>,
    ) -> Result<(), GateError> {
        if !self.belongs_to(token.owner) {
            return Err(GateError::Refused("WORKER_BROKER_ACTIVE_ORIGIN"));
        }
        let connection = context.lifecycle_connection(self)?;
        if !Arc::ptr_eq(&connection, &token.connection) {
            return Err(GateError::Refused("WORKER_BROKER_ACTIVE_ORIGIN"));
        }
        self.check_generation(&token.generation)?;
        if !self.guard.active.iter().any(|entry| {
            entry.session == token.session && Arc::ptr_eq(&entry.identity, &token.identity)
        }) {
            return Err(GateError::Refused("WORKER_BROKER_ACTIVE_CHANGED"));
        }
        Ok(())
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
        if self.guard.active.iter().any(|entry| {
            entry.session == token.session && !Arc::ptr_eq(&entry.identity, &token.identity)
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
    /// Only the actual stop-all caller enters this scope while retaining
    /// admission -> lifecycle. Snapshotting names is DATA, not stop authority.
    pub(super) fn begin_drain(&mut self) -> Result<DrainingLaptops<'_, 'a>, GateError> {
        if self.guard.draining {
            return Err(GateError::Refused("WORKER_BROKER_DRAIN_ALREADY_ACTIVE"));
        }
        let connections = self
            .guard
            .active
            .iter()
            .map(|entry| entry.connection.clone())
            .collect();
        let names = self.entries().map(|(_, name)| name.clone()).collect();
        self.guard.draining = true;
        self.guard.generation = LaunchGeneration(Arc::new(()));
        Ok(DrainingLaptops {
            lifecycle: self,
            connections,
            names,
        })
    }
}
/// Finally-style draining reset under the original held mutex. Dropping this
/// scope never acknowledges a stopped container or any native cleanup.
pub(super) struct DrainingLaptops<'g, 'a> {
    lifecycle: &'g mut LaptopLifecycle<'a>,
    connections: Vec<Arc<WorkerLaunchConnection>>,
    names: Vec<WorkerContainerName>,
}
impl DrainingLaptops<'_, '_> {
    pub(super) fn connections(&self) -> &[Arc<WorkerLaunchConnection>] {
        &self.connections
    }
    pub(super) fn names(&self) -> &[WorkerContainerName] {
        &self.names
    }
}
impl<'a> Deref for DrainingLaptops<'_, 'a> {
    type Target = LaptopLifecycle<'a>;
    fn deref(&self) -> &Self::Target {
        self.lifecycle
    }
}
impl DerefMut for DrainingLaptops<'_, '_> {
    fn deref_mut(&mut self) -> &mut Self::Target {
        self.lifecycle
    }
}
impl Drop for DrainingLaptops<'_, '_> {
    fn drop(&mut self) {
        self.lifecycle.guard.draining = false;
    }
}
