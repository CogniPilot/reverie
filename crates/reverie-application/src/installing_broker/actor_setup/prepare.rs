use super::*;
use sha2::{Digest, Sha256};
impl<'a> Owner<'a> {
    pub(super) fn gate(&self) -> Result<'a, &'a ReservationGate> {
        self.broker
            .resource_reservations()
            .map_err(OfflineActorSetupError::Gate)?
            .ok_or(OfflineActorSetupError::Refused(
                "ACTOR_SETUP_EXISTING_DOMAIN_REQUIRED",
            ))
    }
    pub(super) fn prepare(&mut self) -> Result<'a, ()> {
        self.broker_close
            .claim()
            .map_err(OfflineActorSetupError::Original)?;
        let before = self
            .broker
            .installed
            .snapshot()
            .map_err(OfflineActorSetupError::Gate)?;
        let source = before.source_path().ok_or(OfflineActorSetupError::Refused(
            "ACTOR_SETUP_REGISTERED_SOURCE_REQUIRED",
        ))?;
        self.files = Some(ActorSetupControlFiles::capture(
            source,
            before.configuration(),
        ));
        self.locks = Some(
            ImageMaintenanceLocks::capture(source, before.configuration(), self.end).map_err(
                |cause| {
                    OfflineActorSetupError::Original(OfflineImageSwitchError::maintenance(cause))
                },
            )?,
        );
        self.preview = Some(
            self.gate()?
                .preview_offline_actor_setup(
                    self.files.as_mut().expect("same actor files"),
                    self.end,
                )
                .map_err(OfflineActorSetupError::Gate)?,
        );
        let preview = self.preview.as_ref().expect("same actor preview");
        self.history = Some(
            ActorSetupHistoryObservation::capture(
                &ReservationConfiguration::capture(preview.intent.before().clone()),
                self.end,
            )
            .map_err(|cause| OfflineActorSetupError::History(Rc::new(cause)))?,
        );
        self.history
            .as_mut()
            .expect("same history owner")
            .observe()
            .map_err(OfflineActorSetupError::History)?;
        self.facts = Some(
            ActorSetupFacts::capture(
                &self.broker.storage.runtime,
                preview.intent.after(),
                self.end,
            )
            .map_err(|cause| OfflineActorSetupError::Facts(Rc::new(cause)))?,
        );
        self.facts
            .as_mut()
            .expect("same facts owner")
            .observe()
            .map_err(OfflineActorSetupError::Facts)?;
        let facts = self
            .facts
            .as_ref()
            .expect("same facts owner")
            .document_bytes()
            .map_err(OfflineActorSetupError::Facts)?;
        let history = self
            .history
            .as_ref()
            .expect("same history owner")
            .binding_digest()
            .map_err(OfflineActorSetupError::History)?;
        let mut digest = Sha256::new();
        digest.update(b"native-combined-resource-actor-setup-v1\0");
        digest.update(preview.digest.as_str().as_bytes());
        digest.update(Sha256::digest(facts));
        digest.update(history.as_str().as_bytes());
        self.digest =
            Some(JournalDigest::parse(&format!("{:x}", digest.finalize())).expect("SHA256"));
        self.assert_current()?;
        self.close_locks()
    }
    pub(super) fn assert_current(&mut self) -> Result<'a, ()> {
        self.facts
            .as_mut()
            .expect("same facts owner")
            .assert_current()
            .map_err(OfflineActorSetupError::Facts)?;
        self.history
            .as_ref()
            .expect("same history owner")
            .assert_current()
            .map_err(OfflineActorSetupError::History)?;
        self.admission = Some(
            self.gate()?
                .enter_offline_actor_setup(
                    self.preview.as_ref().expect("same actor preview"),
                    self.files.as_mut().expect("same actor files"),
                    self.end,
                )
                .map_err(OfflineActorSetupError::Gate)?,
        );
        self.close_admission()
    }
    pub(super) fn close_admission(&mut self) -> Result<'a, ()> {
        self.admission.as_mut().map_or(Ok(()), |admission| {
            admission.close().map_err(OfflineActorSetupError::Gate)
        })?;
        self.admission = None;
        Ok(())
    }
    pub(super) fn close_locks(&mut self) -> Result<'a, ()> {
        if let Some(locks) = self.locks.take() {
            self.closed_locks = Some(locks.close().map_err(|cause| {
                OfflineActorSetupError::Original(OfflineImageSwitchError::maintenance(cause))
            })?);
        }
        Ok(())
    }
    pub(super) fn close_service(&mut self) -> Result<'a, ()> {
        if let Some(service) = self.service.take() {
            self.closed_service = Some(service.close().map_err(|cause| {
                OfflineActorSetupError::Original(OfflineImageSwitchError::service(cause))
            })?);
        }
        Ok(())
    }
    pub(super) fn close_inspection(&mut self) -> Result<'a, ()> {
        self.facts.as_mut().map_or(Ok(()), |facts| {
            facts.close().map_err(OfflineActorSetupError::Facts)
        })?;
        if let Some(history) = &mut self.history {
            history.close().map_err(OfflineActorSetupError::History)?;
            history
                .assert_current()
                .map_err(OfflineActorSetupError::History)?;
        }
        self.broker_close
            .close(self.end)
            .map_err(OfflineActorSetupError::Original)
    }
    pub(super) fn cleanup(&mut self, errors: &mut Vec<OfflineActorSetupError<'a>>) {
        if let Some(facts) = &mut self.facts
            && let Err(cause) = facts.close()
        {
            errors.push(OfflineActorSetupError::Facts(cause));
        }
        if let Some(files) = &mut self.files
            && let Err(cause) = files.close_components()
        {
            errors.push(OfflineActorSetupError::Files(cause));
        }
        if let Some(history) = &mut self.history
            && let Err(cause) = history.close()
        {
            errors.push(OfflineActorSetupError::History(cause));
        }
        if let Err(cause) = self.close_admission() {
            errors.push(cause);
        }
        if !self.broker_close.attempted()
            && let Err(cause) = self.broker_close.close(self.end)
        {
            errors.push(OfflineActorSetupError::Original(cause));
        }
        if let Err(cause) = self.close_locks() {
            errors.push(cause);
        }
        if let Err(cause) = self.close_service() {
            errors.push(cause);
        }
    }
}
