use super::*;
impl<'a> Owner<'a> {
    pub(super) fn run(
        &mut self,
        expected: &JournalDigest,
        operation: &JournalId,
    ) -> Result<'a, OfflineActorSetupClosed> {
        require(
            self.digest.as_ref() == Some(expected),
            "ACTOR_SETUP_PREVIEW_CHANGED",
        )?;
        require(
            operation.as_str() != "00000000-0000-0000-0000-000000000000",
            "ACTOR_SETUP_OPERATION_REQUIRED",
        )?;
        let before = self
            .broker
            .installed
            .snapshot()
            .map_err(OfflineActorSetupError::Gate)?;
        let source = before.source_path().ok_or(OfflineActorSetupError::Refused(
            "ACTOR_SETUP_REGISTERED_SOURCE_REQUIRED",
        ))?;
        require(
            self.service
                .as_ref()
                .expect("same stopped service")
                .source()
                == source,
            "ACTOR_SETUP_SERVICE_SOURCE_CHANGED",
        )?;
        self.locks = Some(
            ImageMaintenanceLocks::capture(source, before.configuration(), self.end).map_err(
                |cause| {
                    OfflineActorSetupError::Original(OfflineImageSwitchError::maintenance(cause))
                },
            )?,
        );
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
        let preview = self.preview.as_ref().expect("same actor preview");
        self.admission = Some(
            self.gate()?
                .enter_offline_actor_setup(
                    preview,
                    self.files.as_mut().expect("same actor files"),
                    self.end,
                )
                .map_err(OfflineActorSetupError::Gate)?,
        );
        self.service
            .as_mut()
            .expect("same stopped service")
            .revalidate()
            .map_err(|cause| {
                OfflineActorSetupError::Original(OfflineImageSwitchError::service_component(cause))
            })?;
        self.publish_files(expected, operation)?;
        self.finish_publication()
    }
    fn publish_files(&mut self, expected: &JournalDigest, operation: &JournalId) -> Result<'a, ()> {
        let preview = self.preview.as_ref().expect("same actor preview");
        {
            let lock = self
                .admission
                .as_ref()
                .expect("same R admission")
                .lock()
                .map_err(OfflineActorSetupError::Gate)?;
            let facts = self
                .facts
                .take()
                .expect("move SAME actual native facts into publication owner");
            self.pending = Some(
                self.files
                    .as_mut()
                    .expect("same actor files")
                    .publish_pending(
                        Arc::clone(&preview.intent),
                        facts,
                        operation,
                        expected,
                        self.end,
                    )
                    .map_err(OfflineActorSetupError::Files)?,
            );
            self.history
                .as_mut()
                .expect("same history owner")
                .assert_pending(self.pending.as_ref().expect("same pending owner"))
                .map_err(OfflineActorSetupError::History)?;
            self.terminal = Some(
                self.files
                    .as_mut()
                    .expect("same actor files")
                    .publish(
                        self.pending.as_ref().expect("same pending owner"),
                        &lock,
                        self.locks.as_mut().expect("same maintenance locks"),
                        self.service.as_ref().expect("same stopped service"),
                    )
                    .map_err(OfflineActorSetupError::Files)?,
            );
        }
        Ok(())
    }
    fn finish_publication(&mut self) -> Result<'a, OfflineActorSetupClosed> {
        let preview = self.preview.as_ref().expect("same actor preview");
        self.admission
            .as_ref()
            .expect("same R admission")
            .assert_after(preview, self.end)
            .map_err(OfflineActorSetupError::Gate)?;
        let terminal = self.terminal.as_ref().expect("actual actor terminal");
        let history = self.history.as_mut().expect("same history owner");
        history
            .assert_published(terminal)
            .map_err(OfflineActorSetupError::History)?;
        history
            .close_published(terminal)
            .map_err(OfflineActorSetupError::History)?;
        history
            .assert_published(terminal)
            .map_err(OfflineActorSetupError::History)?;
        let configuration = configuration(preview);
        let digest = self.digest.as_ref().expect("actual preview").clone();
        self.close_admission()?;
        self.broker_close
            .close(self.end)
            .map_err(OfflineActorSetupError::Original)?;
        self.close_locks()?;
        self.close_service()?;
        self.closed_locks
            .as_ref()
            .expect("known lock closure")
            .assert_current()
            .map_err(|cause| {
                OfflineActorSetupError::Original(OfflineImageSwitchError::files(cause))
            })?;
        self.broker_close
            .assert_controller()
            .map_err(OfflineActorSetupError::Original)?;
        let terminal = self.terminal.as_ref().expect("actual actor terminal");
        terminal
            .assert_current()
            .map_err(OfflineActorSetupError::Files)?;
        self.files
            .as_mut()
            .expect("same actor files")
            .release(self.pending.as_mut().expect("same pending owner"), terminal)
            .map_err(OfflineActorSetupError::Files)?;
        let _closed = self
            .closed_service
            .take()
            .expect("known service closure")
            .release()
            .map_err(|cause| {
                OfflineActorSetupError::Original(OfflineImageSwitchError::service(cause))
            })?;
        Ok(OfflineActorSetupClosed {
            configuration,
            preview: digest,
        })
    }
}
