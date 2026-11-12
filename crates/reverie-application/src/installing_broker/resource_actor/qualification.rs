use super::*;
mod pool_publication;
use reverie_core::operations::JournalDigest;
use reverie_host::website_facts::{ImmutableInputKind, WebsiteMetadataRoute};
mod protected_launch;

impl Frame<'_> {
    pub(super) fn prepare(&mut self) -> Result<()> {
        self.retain()?;
        self.prepare_after_retain()
    }
    pub(super) fn prepare_after_retain(&mut self) -> Result<()> {
        if matches!(
            self.purpose,
            WebsitePurpose::RamOperation | WebsitePurpose::FleetPreview
        ) {
            need(
                self.broker.resource_reservations()?.is_some(),
                "RESOURCE_ACTOR_GATE_REQUIRED",
            )?;
        }
        let snapshot = self.broker.configuration()?;
        let end = self.deadline.min(Instant::now() + Duration::from_secs(10));
        let installed = self.private.observe(snapshot.configuration(), end)?;
        self.context = Some(NativeObserver::capture_worker(
            &self.broker.storage.runtime,
            snapshot.configuration().clone(),
        ));
        self.context
            .as_mut()
            .expect("captured actual native context")
            .inherit_worker_stop_budget(&self.broker.storage.runtime.stop_budget())?;
        self.snapshot = Some(snapshot);
        self.engine = Some(WebsiteMetadataObserver::new(&installed.engine)?);
        let (_, graph) = Self::program_graph(&mut self.input, &installed, end)?;
        let metadata = self.website_metadata(&installed, end)?;
        let init = self.processes.observe_init(&metadata, end)?;
        if let Some((pid, start)) = &installed.website.initial {
            need(
                init.pid() == pid && init.start() == start,
                "RESOURCE_ACTOR_WEBSITE_INIT_CHANGED",
            )?;
        }
        let channel = match &mut self.transport {
            Transport::Retained(channel) => channel,
            _ => return Err(ResourceActorError::Refused("RESOURCE_ACTOR_CHANNEL_STATE")),
        };
        let peer = self.processes.observe_peer(channel, end)?;
        need(
            peer.peer().uid() == installed.website.uid
                && peer.peer().gid() == installed.website.gid,
            "RESOURCE_ACTOR_PEER_IDENTITY",
        )?;
        self.bindings = Some(Bindings {
            installed,
            graph,
            init,
            peer: peer.process().clone(),
        });
        self.guard_bootstrap(end)?;
        self.channel()?.greet(end)?;
        Ok(())
    }
    fn program_graph(
        input: &mut ImmutableInputObserver,
        installed: &InstalledFactsDocument,
        end: Instant,
    ) -> Result<(WebsiteImageProvenance, WebsiteProgramGraph)> {
        let raw =
            input.observe_artifact(&installed.provenance, ImmutableInputKind::Provenance, end)?;
        let provenance = WebsiteImageProvenance::decode(raw.bytes())?;
        let raw = input.observe_artifact(&installed.client, ImmutableInputKind::Client, end)?;
        let client = NativeResourceClientManifest::decode(raw.bytes())?;
        input.observe_native_client(&client, end)?;
        let startup = provenance
            .startup_reference()
            .map(|reference| input.observe_artifact(reference, ImmutableInputKind::Startup, end))
            .transpose()?;
        let graph = provenance.program_graph(
            installed,
            &client,
            startup.as_ref().map(|raw| raw.bytes()),
        )?;
        Ok((provenance, graph))
    }
    fn website_metadata(
        &mut self,
        installed: &InstalledFactsDocument,
        end: Instant,
    ) -> Result<QualifiedWebsiteMetadata> {
        let engine = self
            .engine
            .as_mut()
            .expect("actual selected engine retained before I/O");
        engine.guard_same_kernel(end)?;
        let id = JournalDigest::parse(installed.website.container.as_str()).expect("container hex");
        Ok(engine
            .observe(WebsiteMetadataRoute::Container(id), end)?
            .qualify_website(&installed.website)?)
    }
    pub(super) fn guard_bootstrap(&mut self, end: Instant) -> Result<()> {
        self.assert_metadata(end)?;
        let bindings = self
            .bindings
            .as_ref()
            .ok_or(ResourceActorError::Refused("RESOURCE_ACTOR_NOT_BOUND"))?;
        self.private.observe(
            self.snapshot
                .as_ref()
                .expect("bound snapshot")
                .configuration(),
            end,
        )?;
        // Reopen/hash/decode ALL fixed inputs, including optional startup
        // metadata, on every full bootstrap check using the same algorithm.
        let (provenance, _) = Self::program_graph(&mut self.input, &bindings.installed, end)?;
        let engine = self.engine.as_mut().expect("bound engine");
        let image = JournalDigest::parse(&bindings.installed.website.image[7..])
            .expect("selected image hex");
        need(
            engine
                .observe(WebsiteMetadataRoute::Image(image), end)?
                .qualify_image(&provenance)?
                == bindings.installed.website.image,
            "RESOURCE_ACTOR_IMAGE_CHANGED",
        )?;
        let custody = self
            .context
            .as_ref()
            .expect("bound native context")
            .custody(Some(end))
            .map_err(Into::into);
        let rows = match custody {
            Ok(rows) => rows,
            Err(cause) => return self.retain_stateless_result(Err(cause)),
        };
        let name = format!(
            "/{}",
            ReservationConfiguration::capture(
                self.snapshot
                    .as_ref()
                    .expect("bound snapshot")
                    .configuration()
                    .clone()
            )
            .server_container()
            .map_err(GateError::from)?
        );
        let mut sites = rows.rows().filter(|row| row.data().name_is(&name));
        let site = sites
            .next()
            .ok_or(ResourceActorError::Refused("RESOURCE_ACTOR_CURRENT_SITE"))?;
        need(
            sites.next().is_none()
                && site.data().id() == &bindings.installed.website.container
                && site.data().image().map_err(GateError::from)?
                    == bindings.installed.website.image
                && site.data().running().map_err(GateError::from)?
                && site.data().pid().map_err(GateError::from)? == *bindings.init.pid(),
            "RESOURCE_ACTOR_CURRENT_SITE",
        )?;
        for code in &bindings.installed.website.code {
            self.code.observe_file(bindings.init.pid(), code, end)?;
        }
        self.guard_peer(end)
    }
    pub(super) fn guard_peer(&mut self, end: Instant) -> Result<()> {
        self.assert_metadata(end)?;
        self.guard_peer_observations(end)?;
        self.assert_metadata(end)
    }
    pub(super) fn guard_peer_observations(&mut self, end: Instant) -> Result<()> {
        let bindings = self
            .bindings
            .as_ref()
            .ok_or(ResourceActorError::Refused("RESOURCE_ACTOR_NOT_BOUND"))?;
        let engine = self.engine.as_mut().expect("bound engine");
        engine.guard_same_kernel(end)?;
        let id = JournalDigest::parse(bindings.installed.website.container.as_str())
            .expect("container hex");
        let metadata = engine
            .observe(WebsiteMetadataRoute::Container(id.clone()), end)?
            .qualify_website(&bindings.installed.website)?;
        need(
            self.processes.observe_init(&metadata, end)? == bindings.init,
            "RESOURCE_ACTOR_WEBSITE_INIT_CHANGED",
        )?;
        let Transport::Retained(channel) = &mut self.transport else {
            return Err(ResourceActorError::Refused("RESOURCE_ACTOR_CHANNEL_STATE"));
        };
        let protected = self.processes.observe_peer(channel, end)?;
        need(
            protected.process() == &bindings.peer,
            "RESOURCE_ACTOR_NODE_CHANGED",
        )?;
        let ancestry = self
            .processes
            .observe_peer_ancestry(channel, &metadata, end)?;
        need(
            ancestry.peer() == &bindings.peer && ancestry.init() == &bindings.init,
            "RESOURCE_ACTOR_PEER_ANCESTRY_CHANGED",
        )?;
        for selected in bindings.graph.invocations() {
            let manifest = match selected.kind() {
                InvocationKind::LegacyPython => bindings.graph.startup_code_files(),
                _ => &bindings.installed.website.code,
            };
            let observed = self.aliases.observe_alias(
                bindings.init.pid(),
                selected.invocation(),
                manifest,
                end,
            )?;
            if !matches!(selected.kind(), InvocationKind::LegacyPython)
                && let Some(expected) = selected.executable()
            {
                need(
                    observed.canonical_path() == expected,
                    "RESOURCE_ACTOR_FIXED_PROGRAM_CHANGED",
                )?;
            }
        }
        let node = &bindings.installed.website.node;
        let selected = self.aliases.observe_alias(
            bindings.init.pid(),
            &node.argv[0],
            &bindings.installed.website.code,
            end,
        )?;
        need(
            selected.canonical_path() == &node.executable
                && selected.identity() == bindings.peer.executable()
                && node.argv_digest()? == *bindings.peer.argv_digest(),
            "RESOURCE_ACTOR_NODE_CHANGED",
        )?;
        let after = engine
            .observe(WebsiteMetadataRoute::Container(id), end)?
            .qualify_website(&bindings.installed.website)?;
        need(
            self.processes.observe_init(&after, end)? == bindings.init
                && self.processes.observe_peer(channel, end)?.process() == &bindings.peer,
            "RESOURCE_ACTOR_PROCESS_RACE",
        )?;
        engine.guard_same_kernel(end)?;
        channel.require_connected()?;
        Ok(())
    }
}
