//! Read-only observations of the original held L peer against this Q's actual
//! installed website/client. The snapshot is DATA, not allocation authority.
use super::*;
use reverie_host::worker_reports::{HeldProtectedWorkerLaunch, ProtectedLaunchPeerPin};

impl Frame<'_> {
    pub(in crate::installing_broker::resource_actor) fn observe_protected_launch_peer(
        &mut self,
        held: &HeldProtectedWorkerLaunch,
        pin: &ProtectedLaunchPeerPin,
    ) -> Result<ProcessSnapshot> {
        need(
            matches!(self.purpose, WebsitePurpose::RamOperation),
            "RESOURCE_ACTOR_RAM_PURPOSE_REQUIRED",
        )?;
        let end = self.deadline.min(Instant::now() + Duration::from_secs(5));
        self.guard_bootstrap(end)?;
        let runtime = &self.broker.storage.runtime;
        held.incoming().assert_service(&self.broker.reports)?;
        held.assert_current(runtime)?;
        let connection = held.incoming().connection();
        pin.assert_current(runtime, connection)?;
        let bindings = self
            .bindings
            .as_ref()
            .ok_or(ResourceActorError::Refused("RESOURCE_ACTOR_NOT_BOUND"))?;
        let installed = &bindings.installed;
        let engine = self.engine.as_mut().expect("original qualified engine");
        engine.guard_same_kernel(end)?;
        let id = JournalDigest::parse(installed.website.container.as_str())
            .expect("selected container hex");
        let metadata = engine
            .observe(WebsiteMetadataRoute::Container(id.clone()), end)?
            .qualify_website(&installed.website)?;
        need(
            self.processes.observe_init(&metadata, end)? == bindings.init,
            "RESOURCE_ACTOR_WEBSITE_INIT_CHANGED",
        )?;
        let peer = self
            .processes
            .observe_protected_peer(pin, runtime, connection, end)?;
        need(
            peer.peer().uid() == installed.website.uid
                && peer.peer().gid() == installed.website.gid,
            "RESOURCE_ACTOR_PEER_IDENTITY",
        )?;
        let ancestry = self
            .processes
            .observe_protected_peer_ancestry(pin, runtime, connection, &metadata, end)?;
        need(
            ancestry.peer() == peer.process()
                && ancestry.peer_identity().pid() == peer.peer().pid()
                && ancestry.peer_identity().uid() == peer.peer().uid()
                && ancestry.peer_identity().gid() == peer.peer().gid()
                && ancestry.init() == &bindings.init,
            "RESOURCE_ACTOR_PEER_ANCESTRY_CHANGED",
        )?;
        let raw =
            self.input
                .observe_artifact(&installed.client, ImmutableInputKind::Client, end)?;
        let client = NativeResourceClientManifest::decode(raw.bytes())?;
        let executable = self.input.observe_native_client(&client, end)?;
        let program = protected_program(&client, held);
        let expected_argv = program.argv_digest()?;
        let store_prefix = "/nix/store/".chars().map(u32::from).collect::<Vec<_>>();
        for argument in program.argv.iter().skip(1) {
            if argument.codepoints().starts_with(&store_prefix) {
                self.aliases.observe_alias(
                    bindings.init.pid(),
                    argument,
                    &installed.website.code,
                    end,
                )?;
            }
        }
        let alias = self.aliases.observe_alias(
            bindings.init.pid(),
            client.executable(),
            &installed.website.code,
            end,
        )?;
        need(
            alias.canonical_path() == client.executable()
                && alias.identity() == executable.identity()
                && alias.identity() == peer.process().executable()
                && expected_argv == *peer.process().argv_digest(),
            "RESOURCE_ACTOR_NATIVE_CLIENT_CHANGED",
        )?;
        let after = engine
            .observe(WebsiteMetadataRoute::Container(id), end)?
            .qualify_website(&installed.website)?;
        need(
            self.processes.observe_init(&after, end)? == bindings.init
                && self
                    .processes
                    .observe_protected_peer(pin, runtime, connection, end)?
                    .process()
                    == peer.process(),
            "RESOURCE_ACTOR_PROCESS_RACE",
        )?;
        engine.guard_same_kernel(end)?;
        held.assert_current(runtime)?;
        pin.assert_current(runtime, connection)?;
        self.assert_metadata(end)?;
        self.channel()?.require_connected()?;
        Ok(peer.process().clone())
    }
}

fn protected_program(
    client: &NativeResourceClientManifest,
    held: &HeldProtectedWorkerLaunch,
) -> ProgramSelection {
    use reverie_core::PythonText;
    let incoming = held.incoming();
    let request = incoming.connection().request();
    let argv = vec![
        client.executable().clone(),
        PythonText::from_scalar_text("--resource-ref"),
        PythonText::from_scalar_text(incoming.reference().as_str()),
        PythonText::from_scalar_text("--session-id"),
        PythonText::from_scalar_text(request.session().as_str()),
        PythonText::from_scalar_text("--cwd"),
        PythonText::try_new(request.directory().codepoints().to_vec())
            .expect("validated request codepoints"),
        PythonText::from_scalar_text("--command"),
        PythonText::try_new(request.command().codepoints().to_vec())
            .expect("validated request codepoints"),
    ];
    ProgramSelection {
        executable: client.executable().clone(),
        argv,
    }
}
