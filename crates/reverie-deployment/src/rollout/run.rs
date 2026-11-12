use super::*;
impl<'a> Owner<'a> {
    pub(super) fn run(&mut self) -> RolloutResult<'a, InitialWebsiteRolloutClosed> {
        self.preflight()?;
        self.begin_service_maintenance()?;
        self.prepare_website_phase()?;
        self.install_actor()
    }
    fn begin_service_maintenance(&mut self) -> RolloutResult<'a, ()> {
        self.service = Some(
            (if self.flow.refresh() {
                maintain_stopped_deployment_service(
                    &self.source,
                    NativeWorkerServiceRole::PoolOfferV1,
                    self.end,
                )
            } else {
                quiesce_stopped_worker_service(
                    &self.source,
                    NativeWorkerServiceRole::Broker,
                    self.end,
                )
            })
            .map_err(InitialWebsiteRolloutError::Quiesce)?,
        );
        self.end = self.end.min(
            self.service
                .as_ref()
                .expect("same actual IMAGE fence")
                .end(),
        );
        self.deployment
            .as_mut()
            .expect("same deployment owner")
            .restrict_initial_website(self.end)
            .map_err(InitialWebsiteRolloutError::Deployment)?;
        self.assert_service_current()?;
        self.check_time()
    }
    fn prepare_website_phase(&mut self) -> RolloutResult<'a, ()> {
        if let Some(operation) = self.flow.recovery_operation() {
            self.status = Some(
                self.deployment
                    .as_ref()
                    .expect("same deployment owner")
                    .actor_recovery_status(operation, &self.image, self.end)
                    .map_err(InitialWebsiteRolloutError::Deployment)?,
            );
            self.close_deployment()?;
            self.assert_service_current()?;
            return Ok(());
        }
        let deployment = self.deployment.as_ref().expect("same deployment owner");
        // Quiesce owns its original STOP/IMAGE records. The actual deployment
        // OP is retained before any candidate creation or apply effects.
        self.preview = Some(
            deployment
                .preview_with_profile(&self.image, DeploymentProfile::ProtectedWebsite)
                .map_err(InitialWebsiteRolloutError::Deployment)?,
        );
        self.assert_service_current()?;
        let deployment = self.deployment.as_ref().expect("same deployment owner");
        let operation = &self
            .preview
            .as_ref()
            .expect("actual deployment preview")
            .operation;
        self.status = Some(
            deployment
                .prepare_before(operation, self.end)
                .map_err(InitialWebsiteRolloutError::Deployment)?,
        );
        self.assert_service_current()?;
        let deployment = self.deployment.as_ref().expect("same deployment owner");
        let operation = &self
            .preview
            .as_ref()
            .expect("actual deployment preview")
            .operation;
        self.check_time()?;
        self.status = Some(
            (if self.flow.skip_backup() {
                deployment.apply_without_backup_before(operation, self.end)
            } else {
                deployment.apply_before(operation, self.end)
            })
            .map_err(InitialWebsiteRolloutError::Deployment)?,
        );
        self.assert_service_current()?;
        let deployment = self.deployment.as_ref().expect("same deployment owner");
        let operation = &self
            .preview
            .as_ref()
            .expect("actual deployment preview")
            .operation;
        self.check_time()?;
        self.status = Some(
            deployment
                .status_before(operation, self.end)
                .map_err(InitialWebsiteRolloutError::Deployment)?,
        );
        require(
            self.status.as_ref().expect("actual readiness").stage == "HYBRID_READY",
            "INITIAL_WEBSITE_READINESS_UNCONFIRMED",
        )?;
        // Actor setup acquires the same update.lock through its real native
        // maintenance owner. Release this original lock first, keep IMAGE.
        self.close_deployment()?;
        self.assert_service_current()?;
        Ok(())
    }
    fn install_actor(&mut self) -> RolloutResult<'a, InitialWebsiteRolloutClosed> {
        self.check_time()?;
        self.actor_attempted = true;
        self.actor = Some(
            (if self.flow.refresh() {
                self.broker.prepare_offline_actor_refresh(self.end)
            } else {
                self.broker.prepare_offline_actor_setup(self.end)
            })
            .map_err(InitialWebsiteRolloutError::Actor)?,
        );
        let candidate = self
            .status
            .as_ref()
            .and_then(|status| status.candidate_id.as_deref())
            .and_then(|id| reverie_core::ids::ContainerId::parse(id).ok())
            .ok_or(InitialWebsiteRolloutError::Refused(
                "DEPLOYMENT_ACTOR_RECOVERY_SELECTION_CHANGED",
            ))?;
        self.actor = Some(
            self.actor
                .take()
                .expect("same actual actor preparation")
                .require_website(&candidate, &self.image)
                .map_err(InitialWebsiteRolloutError::Actor)?,
        );
        self.assert_service_current()?;
        let prepared = self
            .actor
            .take()
            .expect("actual original actor preparation");
        let expected = prepared.preview_digest().clone();
        let service = self
            .service
            .take()
            .expect("transfer SAME IMAGE service owner");
        let actor = prepared
            .apply(
                service,
                &expected,
                self.operation.as_ref().expect("original operation UUID"),
            )
            .map_err(InitialWebsiteRolloutError::Actor)?;
        Ok(InitialWebsiteRolloutClosed {
            operation: self.operation.take().expect("original operation UUID"),
            deployment: self.status.take().expect("actual website status"),
            actor,
        })
    }
    fn preflight(&mut self) -> RolloutResult<'a, ()> {
        self.check_time()?;
        crate::model::image_id(&self.image).map_err(InitialWebsiteRolloutError::Deployment)?;
        self.operation = Some(fresh_owner_nonce().map_err(InitialWebsiteRolloutError::Bootstrap)?);
        let original = self
            .broker
            .configuration()
            .map_err(InitialWebsiteRolloutError::Gate)?;
        self.require_actor_mode(original.configuration())?;
        let current =
            load_owner_config(&self.source).map_err(InitialWebsiteRolloutError::Validation)?;
        self.require_actor_mode(current.configuration())?;
        require(
            current.source_path() == original.source_path()
                && worker_config::equivalent(current.configuration(), original.configuration())
                && current.configuration().session_resource_order()
                    == original.configuration().session_resource_order(),
            "INITIAL_WEBSITE_SOURCE_CHANGED",
        )?;
        if self.flow.refresh() {
            self.previous_facts
                .observe(current.configuration(), self.end)
                .map_err(InitialWebsiteRolloutError::Bootstrap)?;
        }
        self.source = current
            .source_path()
            .ok_or(InitialWebsiteRolloutError::Refused(
                "INITIAL_WEBSITE_REGISTERED_SOURCE_REQUIRED",
            ))?
            .to_owned();
        self.deployment = Some(
            DeploymentService::capture(&self.root)
                .map_err(InitialWebsiteRolloutError::Deployment)?,
        );
        self.deployment
            .as_mut()
            .expect("same deployment owner")
            .restrict_initial_website(self.end)
            .map_err(InitialWebsiteRolloutError::Deployment)?;
        let name = ReservationConfiguration::capture(original.configuration().clone())
            .server_container()
            .map_err(InitialWebsiteRolloutError::Inventory)?;
        require(
            self.deployment
                .as_ref()
                .expect("same deployment owner")
                .registered_container_name()
                == name,
            "INITIAL_WEBSITE_REGISTERED_SELECTION_CHANGED",
        )?;
        self.qualify_target()?;
        self.deployment
            .as_ref()
            .expect("same deployment owner")
            .check_initial_website_selection(&self.image)
            .map_err(InitialWebsiteRolloutError::Deployment)
    }
    fn require_actor_mode(
        &self,
        config: &worker_config::EffectiveWorkerConfig,
    ) -> RolloutResult<'a, ()> {
        if self.flow.refresh() {
            ResourceActorSettings::capture(config).map_err(InitialWebsiteRolloutError::Data)?;
            require(
                reverie_contracts::worker_pool::WorkerPoolProvider::from_config(config)
                    .map_err(|_| {
                        InitialWebsiteRolloutError::Refused("WEBSITE_UPDATE_POOL_CONFIGURATION")
                    })?
                    .is_none(),
                "WEBSITE_UPDATE_ACTIVE_POOL_REQUIRES_MIGRATION",
            )
        } else {
            ResourceActorSettings::require_unselected(config)
                .map_err(InitialWebsiteRolloutError::Data)
        }
    }
    fn qualify_target(&mut self) -> RolloutResult<'a, ()> {
        use reverie_contracts::resource_actor::{EngineMetadata, WebsiteImageProvenance};
        use reverie_host::{
            resource_facts::compiled_actor_image_provenance_reference,
            website_facts::ImmutableInputKind,
        };
        let reference = compiled_actor_image_provenance_reference()
            .map_err(InitialWebsiteRolloutError::FixedReference)?
            .ok_or(InitialWebsiteRolloutError::Refused(
                "INITIAL_WEBSITE_FIXED_PROVENANCE_REQUIRED",
            ))?;
        let raw = self
            .input
            .observe_artifact(&reference, ImmutableInputKind::Provenance, self.end)
            .map_err(InitialWebsiteRolloutError::Input)?;
        let provenance = WebsiteImageProvenance::decode(raw.bytes())
            .map_err(InitialWebsiteRolloutError::Data)?;
        let raw = self
            .deployment
            .as_ref()
            .expect("same deployment owner")
            .initial_actor_image(&self.image)
            .map_err(InitialWebsiteRolloutError::Deployment)?;
        let bytes = serde_json::to_vec(&raw)
            .map_err(|cause| InitialWebsiteRolloutError::Deployment(cause.into()))?;
        let image = EngineMetadata::decode(&bytes)
            .map_err(InitialWebsiteRolloutError::Data)?
            .qualify_image(&provenance)
            .map_err(InitialWebsiteRolloutError::Data)?;
        require(image == self.image, "INITIAL_WEBSITE_FACTORY_IMAGE_CHANGED")?;
        self.input
            .assert_finalized()
            .map_err(InitialWebsiteRolloutError::Input)
    }
    pub(super) fn close_deployment(&mut self) -> RolloutResult<'a, ()> {
        if !self.deployment_close_attempted {
            self.deployment_close_attempted = true;
            self.deployment
                .as_mut()
                .map_or(Ok(()), |deployment| deployment.close())
                .map_err(InitialWebsiteRolloutError::Deployment)?;
        }
        Ok(())
    }
    fn check_time(&self) -> RolloutResult<'a, ()> {
        require(Instant::now() < self.end, "INITIAL_WEBSITE_DEADLINE")
    }
    fn assert_service_current(&mut self) -> RolloutResult<'a, ()> {
        self.check_time()?;
        self.service
            .as_mut()
            .expect("same actual IMAGE fence")
            .revalidate()
            .map_err(InitialWebsiteRolloutError::Service)?;
        if self.flow.refresh() {
            self.previous_facts
                .assert_metadata(
                    self.broker
                        .configuration()
                        .map_err(InitialWebsiteRolloutError::Gate)?
                        .configuration(),
                    self.end,
                )
                .map_err(InitialWebsiteRolloutError::Bootstrap)?;
        }
        Ok(())
    }
}
