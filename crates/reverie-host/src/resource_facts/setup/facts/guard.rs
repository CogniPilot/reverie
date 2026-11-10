use super::*;
impl ActorSetupFacts {
    pub(super) fn guard(&mut self) -> FactsResult<()> {
        self.current()?;
        let (reference, provenance, client, startup) = self.inputs()?;
        let bound = self.bound.as_ref().ok_or(ActorSetupFactsError::Refused(
            "ACTOR_SETUP_FACTS_UNOBSERVED",
        ))?;
        require(
            reference == bound.document.provenance,
            "ACTOR_SETUP_FIXED_PROVENANCE_CHANGED",
        )?;
        provenance.program_graph(
            &bound.document,
            &client,
            startup.as_ref().map(|raw| raw.bytes()),
        )?;
        self.native_bracket(&provenance)?;
        self.observe_programs()?;
        self.native_bracket(&provenance)
    }
    fn native_bracket(&mut self, provenance: &WebsiteImageProvenance) -> FactsResult<()> {
        self.current()?;
        let end = self.deadline();
        let bound = self.bound.as_ref().expect("actual observed facts");
        let site = self.site()?;
        require(
            site.id() == &bound.document.website.container
                && site.image().map_err(ActorSetupFactsError::Inventory)?
                    == bound.document.website.image
                && site.pid().map_err(ActorSetupFactsError::Inventory)? == *bound.init.pid(),
            "ACTOR_SETUP_NATIVE_SITE_CHANGED",
        )?;
        let info = EngineMetadata::decode(self.query(EngineQuery::GpuInformation)?.as_bytes())?;
        info.require_same_kernel(
            &bound.document.engine.id,
            &native::kernel_release()
                .map_err(|_| ActorSetupFactsError::Refused("ACTOR_SETUP_SAME_KERNEL_REQUIRED"))?,
        )?;
        let id = JournalDigest::parse(site.id().as_str()).expect("typed container hex");
        let image =
            JournalDigest::parse(&bound.document.website.image[7..]).expect("typed image hex");
        let http = self.http.as_mut().expect("same fixed HTTP owner");
        http.guard_same_kernel(end)?;
        require(
            http.observe(WebsiteMetadataRoute::Image(image), end)?
                .qualify_image(provenance)?
                == bound.document.website.image,
            "ACTOR_SETUP_IMAGE_CHANGED",
        )?;
        let metadata = http
            .observe(WebsiteMetadataRoute::Container(id), end)?
            .qualify_website(&bound.document.website)?;
        let observed = self.processes.observe_setup_node(
            &self.engine,
            &self.query,
            &SetupNodeSelection {
                site: site.id(),
                metadata: &metadata,
                prefix: provenance.node_prefix(),
                identity: [bound.document.website.uid, bound.document.website.gid],
                cancellation: &self.cancellation,
            },
            end,
        )?;
        require(
            observed.init() == &bound.init
                && observed.node() == &bound.node
                && observed.argv() == bound.document.website.node.argv,
            "ACTOR_SETUP_PROCESS_CHANGED",
        )?;
        self.http
            .as_mut()
            .expect("same fixed HTTP owner")
            .guard_same_kernel(end)?;
        self.current()
    }
    fn observe_programs(&mut self) -> FactsResult<()> {
        self.current()?;
        let end = self.deadline();
        let bound = self.bound.as_ref().expect("actual observed facts");
        for code in &bound.document.website.code {
            self.code.observe_file(bound.init.pid(), code, end)?;
        }
        for selection in bound.graph.invocations() {
            let manifest = match selection.kind() {
                reverie_contracts::resource_actor::InvocationKind::LegacyPython => {
                    bound.graph.startup_code_files()
                }
                _ => &bound.document.website.code,
            };
            let alias = self.aliases.observe_alias(
                bound.init.pid(),
                selection.invocation(),
                manifest,
                end,
            )?;
            if !matches!(
                selection.kind(),
                reverie_contracts::resource_actor::InvocationKind::LegacyPython
            ) && let Some(executable) = selection.executable()
            {
                require(
                    alias.canonical_path() == executable,
                    "ACTOR_SETUP_PROGRAM_CHANGED",
                )?;
            }
        }
        let node = &bound.document.website.node;
        let actual = self.aliases.observe_alias(
            bound.init.pid(),
            &node.argv[0],
            &bound.document.website.code,
            end,
        )?;
        require(
            actual.canonical_path() == &node.executable
                && actual.identity() == bound.node.executable()
                && node.argv_digest()? == *bound.node.argv_digest(),
            "ACTOR_SETUP_NODE_CHANGED",
        )?;
        self.current()
    }
}
