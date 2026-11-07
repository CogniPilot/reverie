//! Actual create ACK mints ownership before publication/start/memory. Every
//! refusal retains it; only the real pane and guard finalizers reach Started.
use super::*;
use reverie_host::worker_laptop::{
    ColdCommit, ContainerStart, LaptopCreation, NixGuardRelease, PaneStart,
};
impl<'a> ColdBody<'a> {
    pub(super) fn start_body(&mut self) -> Result<Arc<StartedLaptop>, ColdError> {
        let network = self.network();
        let connection = self.scope.preparing.admitted.request.connection.clone();
        // Complete late argv and the mandatory same-runtime telemetry check
        // happen in the actual record immediately before its fixed create.
        let created =
            match network.create_for_connection(self.broker().command_telemetry(), &connection)? {
                LaptopCreation::Created(created) => created,
                LaptopCreation::Rejected | LaptopCreation::Retained => {
                    return Err(Self::phase_refused(
                        &network,
                        "WORKER_COLD_CREATE_UNCONFIRMED",
                    ));
                }
            };
        self.creation = Some(CreationContext {
            created,
            started: None,
            pane: None,
        });
        let creation = self
            .creation
            .as_mut()
            .expect("successful create owns target");
        network.publish_created(&creation.created)?;
        match network.start_for_connection(&creation.created, &connection)? {
            ContainerStart::Started(started) => creation.started = Some(started),
            ContainerStart::Rejected | ContainerStart::Retained => {
                return Err(Self::phase_refused(
                    &network,
                    "WORKER_COLD_START_UNCONFIRMED",
                ));
            }
        }
        let memory = self.configure_memory()?;
        let cold = match network.commit_cold(&memory, &connection)? {
            ColdCommit::Committed(cold) => cold,
            ColdCommit::Rejected | ColdCommit::Retained => {
                return Err(Self::phase_refused(
                    &network,
                    "WORKER_COLD_COMMIT_UNCONFIRMED",
                ));
            }
        };
        let pane = match network.start_pane(&cold, &connection)? {
            PaneStart::Started(pane) => pane,
            PaneStart::Rejected | PaneStart::Retained => {
                return Err(Self::phase_refused(
                    &network,
                    "WORKER_COLD_PANE_UNCONFIRMED",
                ));
            }
        };
        // This is ordinary J, never a fabricated protected CLI receipt. The
        // protected launch producer must supply its own durable joins later.
        let released = match network.close_nix_guard(&pane, &connection)? {
            NixGuardRelease::Released(released) => released,
            NixGuardRelease::Retained => {
                return Err(Self::phase_refused(
                    &network,
                    "WORKER_COLD_NIX_CLOSE_UNCONFIRMED",
                ));
            }
        };
        // The original started predicate becomes true after actual pane and
        // guard completion, even if later App registry allocation refuses.
        // Retain that real token before attempting the fallible publication.
        self.creation.as_mut().expect("actual Created").pane = Some(released);
        self.register_started(network)
    }
    fn register_started(
        &mut self,
        network: Arc<storage::NetworkStoragePreparation>,
    ) -> Result<Arc<StartedLaptop>, ColdError> {
        let sid = self.scope.preparing.admitted.request().session().clone();
        let current = self.broker().configuration()?;
        let name = WorkerContainerName::for_session(current.envelope().base(), &sid);
        // Reserve before moving any actual phase/resource token. Replacement
        // of an existing member then has no fallible publication step.
        let at = self
            .lifecycle()
            .guard
            .iter()
            .position(|entry| entry.session == sid);
        if at.is_none() {
            self.lifecycle
                .as_mut()
                .expect("actual life")
                .guard
                .try_reserve(1)
                .map_err(|_| ColdError::Refused("WORKER_LAPTOP_REGISTRY_UNAVAILABLE"))?;
        }
        let creation = self.creation.take().expect("actual Created");
        let started = Arc::new(StartedLaptop {
            network,
            pane: creation.pane.expect("actual pane and guard completion"),
            office: self.office.as_ref().expect("actual phone").clone(),
            created: creation.created,
        });
        // Admission can still fail after registration. The failure keeps the
        // actual Created/pane owner, without a later SID/path reconstruction.
        self.started = Some(started.clone());
        let entry = LaptopRegistration {
            session: sid,
            name,
            owner: LaptopOwner::Started(started.clone()),
        };
        let life = self.lifecycle.as_mut().expect("actual held lifecycle");
        if let Some(at) = at {
            life.guard[at] = entry;
        } else {
            life.guard.push(entry);
        }
        Ok(started)
    }
}
