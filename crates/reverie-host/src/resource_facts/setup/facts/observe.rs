use super::*;
impl ActorSetupFacts {
    pub(super) fn prepare(&mut self) -> FactsResult<()> {
        self.current()?;
        let selected = ResourceActorSettings::capture(&self.config)?;
        require(
            selected.uid() == native::uid() && selected.gid() == nix::unistd::getgid().as_raw(),
            "ACTOR_SETUP_ORDINARY_OWNER",
        )?;
        let native_info =
            EngineMetadata::decode(self.query(EngineQuery::GpuInformation)?.as_bytes())?;
        let engine_id = native_info.declared_engine_id()?;
        let kernel = native::kernel_release()
            .map_err(|_| ActorSetupFactsError::Refused("ACTOR_SETUP_SAME_KERNEL_REQUIRED"))?;
        native_info.require_same_kernel(&engine_id, &kernel)?;
        // This is the existing controller's fixed rootful engine endpoint.
        // Matching actual client ID/kernel is mandatory, not inferred by path.
        let socket = "/var/run/docker.sock";
        let info = std::fs::symlink_metadata(socket)?;
        require(
            info.file_type().is_socket(),
            "ACTOR_SETUP_ENGINE_SOCKET_REQUIRED",
        )?;
        let engine = EngineSelection {
            socket: PythonText::from_scalar_text(socket),
            identity: [
                info.dev(),
                info.ino(),
                u64::from(info.uid()),
                u64::from(info.gid()),
            ]
            .map(UnsignedInteger::from_u64),
            id: engine_id,
        };
        self.http = Some(WebsiteMetadataObserver::new(&engine)?);
        let end = self.deadline();
        self.http
            .as_mut()
            .expect("same fixed HTTP owner")
            .guard_same_kernel(end)?;
        let (reference, provenance, client, startup) = self.inputs()?;
        let site = self.site()?;
        let id = JournalDigest::parse(site.id().as_str()).expect("typed container hex");
        let raw = self
            .http
            .as_mut()
            .expect("same fixed HTTP owner")
            .observe(WebsiteMetadataRoute::Container(id), end)?;
        let digests = raw.installation_website_digests()?;
        let website = WebsiteSelection {
            container: site.id().clone(),
            image: site.image().map_err(ActorSetupFactsError::Inventory)?,
            config_digest: digests[0].clone(),
            host_config_digest: digests[1].clone(),
            mounts_digest: digests[2].clone(),
            initial: None,
            uid: selected.uid(),
            gid: selected.gid(),
            bootstrap: ProgramSelection {
                executable: client.executable().clone(),
                argv: vec![client.executable().clone()],
            },
            node: provenance.node_prefix().clone(),
            code: provenance.code_files().to_vec(),
        };
        let metadata = raw.qualify_website(&website)?;
        require(
            metadata.pid() == &site.pid().map_err(ActorSetupFactsError::Inventory)?,
            "ACTOR_SETUP_NATIVE_SITE_CHANGED",
        )?;
        let process = self.processes.observe_setup_node(
            &self.engine,
            &self.query,
            &SetupNodeSelection {
                site: site.id(),
                metadata: &metadata,
                prefix: provenance.node_prefix(),
                identity: [selected.uid(), selected.gid()],
                cancellation: &self.cancellation,
            },
            end,
        )?;
        let website = WebsiteSelection {
            initial: Some((process.init().pid().clone(), process.init().start().clone())),
            node: ProgramSelection {
                executable: provenance.node_prefix().executable.clone(),
                argv: process.argv().to_vec(),
            },
            ..website
        };
        let document = provenance.initial_installation_document(
            selected.domain().clone(),
            engine,
            website,
            reference,
            &client,
        )?;
        selected.require_document(&document)?;
        let graph = provenance.program_graph(
            &document,
            &client,
            startup.as_ref().map(|raw| raw.bytes()),
        )?;
        let raw = document.configuration_bytes()?;
        self.bound = Some(Bound {
            document,
            raw,
            graph,
            init: process.init().clone(),
            node: process.node().clone(),
        });
        self.guard()
    }
    pub(super) fn inputs(
        &mut self,
    ) -> FactsResult<(
        ArtifactReference,
        WebsiteImageProvenance,
        NativeResourceClientManifest,
        Option<ObservedImmutableInput>,
    )> {
        let end = self.deadline();
        let reference = compiled_actor_image_provenance_reference()?.ok_or(
            ActorSetupFactsError::Refused("ACTOR_SETUP_FIXED_PROVENANCE_REQUIRED"),
        )?;
        let raw = self
            .input
            .observe_artifact(&reference, ImmutableInputKind::Provenance, end)?;
        let provenance = WebsiteImageProvenance::decode(raw.bytes())?;
        let raw = self.input.observe_artifact(
            provenance.client_reference(),
            ImmutableInputKind::Client,
            end,
        )?;
        let client = NativeResourceClientManifest::decode(raw.bytes())?;
        self.input.observe_native_client(&client, end)?;
        let startup = provenance
            .startup_reference()
            .map(|reference| {
                self.input
                    .observe_artifact(reference, ImmutableInputKind::Startup, end)
            })
            .transpose()?;
        Ok((reference, provenance, client, startup))
    }
}
