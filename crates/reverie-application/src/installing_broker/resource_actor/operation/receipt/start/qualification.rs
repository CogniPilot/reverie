//! The original Q retains the actual L metadata owner across commonCold. The
//! closed successful phase cannot be assembled from a snapshot or command flag.
use super::*;
use reverie_core::operations::JournalDigest;
use reverie_host::worker_reports::{
    HeldProtectedWorkerLaunch, ProtectedLaunchPeerPin, WorkerLaunchConnection,
};

enum Stage {
    Attempting,
    Qualified(ProcessSnapshot),
}
struct Owner {
    connection: Arc<WorkerLaunchConnection>,
    pin: ProtectedLaunchPeerPin,
    request_digest: JournalDigest,
    stage: Stage,
}
pub(super) struct LaunchPeer {
    owner: Option<Box<Owner>>,
}
impl LaunchPeer {
    fn owner(&self) -> &Owner {
        self.owner
            .as_deref()
            .expect("original L metadata owner retained")
    }
    fn owner_mut(&mut self) -> &mut Owner {
        self.owner
            .as_deref_mut()
            .expect("original L metadata owner retained")
    }
    fn snapshot(&self) -> Result<&ProcessSnapshot> {
        match &self.owner().stage {
            Stage::Qualified(snapshot) => Ok(snapshot),
            Stage::Attempting => Err(ResourceActorError::Refused(
                "RESOURCE_RAM_LAUNCH_QUALIFICATION_REQUIRED",
            )),
        }
    }
}
impl Drop for LaunchPeer {
    fn drop(&mut self) {
        // No domain terminal owner exists yet. Preserve the complete native
        // metadata owner even if a caller drops its surrounding failed phase.
        if let Some(owner) = self.owner.take() {
            std::mem::forget(owner);
        }
    }
}
impl PreparedResourceStart<'_> {
    /// The caller's whole attempt already owns Held L and its pin. Pure
    /// pretransfer refusals keep that pin untouched; after transfer every
    /// failure stays in this same Prepared owner and poisons its original Q.
    pub fn qualify_launch_peer(
        &mut self,
        held: &HeldProtectedWorkerLaunch,
        pin: &mut Option<ProtectedLaunchPeerPin>,
    ) -> Result<()> {
        let result = (|| {
            need(
                self.qualification.is_none(),
                "RESOURCE_RAM_LAUNCH_ALREADY_QUALIFIED",
            )?;
            need(pin.is_some(), "RESOURCE_RAM_LAUNCH_PIN_REQUIRED")?;
            self.qualification = Some(LaunchPeer {
                owner: Some(Box::new(Owner {
                    connection: held.incoming().connection().clone(),
                    pin: pin.take().expect("actual pin checked before transfer"),
                    request_digest: held.incoming().request_digest().clone(),
                    stage: Stage::Attempting,
                })),
            });
            self.qualify_launch_body(held)
        })();
        self.operation.owner_mut().auth.website.frame.failed |= result.is_err();
        result
    }
    fn qualify_launch_body(&mut self, held: &HeldProtectedWorkerLaunch) -> Result<()> {
        self.assert_live()?;
        let own = self.operation.owner_mut();
        need(
            held.incoming().reference() == own.auth.reference()?,
            "RESOURCE_RAM_LAUNCH_REFERENCE_CHANGED",
        )?;
        let peer = self
            .qualification
            .as_ref()
            .expect("original pin moved before checks")
            .owner();
        let frame = &mut own.auth.website.frame;
        let observed = frame.observe_protected_launch_peer(held, &peer.pin);
        let snapshot = frame.retain_stateless_result(observed)?;
        self.assert_launch_command(held)?;
        let own = self.operation.owner_mut();
        held.assert_current(&own.auth.website.frame.broker.storage.runtime)?;
        self.assert_live()?;
        self.qualification
            .as_mut()
            .expect("original native owner retained")
            .owner_mut()
            .stage = Stage::Qualified(snapshot);
        self.assert_qualified_launch_live(
            held.incoming().connection(),
            held.incoming().request_digest(),
        )
    }
    pub(super) fn assert_launch_phase_current(&self) -> Result<()> {
        self.qualification
            .as_ref()
            .map_or(Ok(()), |peer| peer.snapshot().map(|_| ()))
    }
    pub(super) fn assert_launch_peer_live(&self) -> Result<()> {
        if let Some(peer) = &self.qualification {
            let peer = peer.owner();
            let broker = self.operation.owner().auth.website.frame.broker;
            peer.pin.assert_service(&broker.reports)?;
            peer.pin
                .assert_current(&broker.storage.runtime, &peer.connection)?;
        }
        Ok(())
    }
    pub(super) fn assert_launch_peer_current(&mut self) -> Result<()> {
        let Some(peer) = &self.qualification else {
            return Ok(());
        };
        let expected = peer.snapshot()?;
        let peer = peer.owner();
        let own = self.operation.owner_mut();
        let reference = own.auth.reference()?.clone();
        let frame = &mut own.auth.website.frame;
        let observed =
            frame.observe_protected_launch_connection(&peer.connection, &peer.pin, &reference);
        let observed = frame.retain_stateless_result(observed)?;
        need(&observed == expected, "RESOURCE_RAM_LAUNCH_PROCESS_CHANGED")?;
        let selected = RamLaunchCommandData::from_observed_data(
            own.auth.request(),
            &reference,
            peer.connection.request(),
            &peer.request_digest,
        )?;
        own.auth.assert_launch_command(&selected)?;
        self.assert_live()
    }
    /// Used by actual protected allocation delegates. Neither a successful
    /// command-only check nor another connection can satisfy this boundary.
    pub(in crate::installing_broker) fn assert_qualified_launch_live(
        &mut self,
        connection: &WorkerLaunchConnection,
        request_digest: &JournalDigest,
    ) -> Result<()> {
        let result = (|| {
            let peer = self
                .qualification
                .as_ref()
                .ok_or(ResourceActorError::Refused(
                    "RESOURCE_RAM_LAUNCH_QUALIFICATION_REQUIRED",
                ))?;
            peer.snapshot()?;
            need(
                std::ptr::eq(peer.owner().connection.as_ref(), connection)
                    && &peer.owner().request_digest == request_digest,
                "RESOURCE_RAM_LAUNCH_CONNECTION_CHANGED",
            )?;
            self.assert_live()
        })();
        self.operation.owner_mut().auth.website.frame.failed |= result.is_err();
        result
    }
    pub(super) fn close_launch_peer_component(&mut self) -> Result<()> {
        let result = self.qualification.as_mut().map_or(Ok(()), |peer| {
            peer.owner_mut().pin.close_metadata().map_err(Into::into)
        });
        self.operation
            .owner_mut()
            .auth
            .website
            .frame
            .retain_stateless_result(result)
    }
}
