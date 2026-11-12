//! Initial installer observation. Only the same actual engine's fixed top
//! response selects candidates; this is process DATA, never a Q/owner grant.
use super::*;
use crate::engine_metadata::{CancellationToken, EngineQuery, MetadataQueryOwner, ReadonlyEngine};
use reverie_contracts::{
    resource_actor::ProgramSelection, worker_provider_health::ProviderTopology,
};
use reverie_core::{PythonText, ids::ContainerId};

pub struct SetupNodeObservation {
    init: ProcessSnapshot,
    node: ProcessSnapshot,
    argv: Vec<PythonText>,
}
/// Selection DATA; only actual native readback can produce an observation.
pub struct SetupNodeSelection<'a> {
    pub site: &'a ContainerId,
    pub metadata: &'a QualifiedWebsiteMetadata,
    pub prefix: &'a ProgramSelection,
    pub identity: [u32; 2],
    pub cancellation: &'a CancellationToken,
}
impl SetupNodeObservation {
    pub fn init(&self) -> &ProcessSnapshot {
        &self.init
    }
    pub fn node(&self) -> &ProcessSnapshot {
        &self.node
    }
    pub fn argv(&self) -> &[PythonText] {
        &self.argv
    }
}
impl WebsiteProcessObserver {
    pub fn observe_setup_node(
        &mut self,
        engine: &ReadonlyEngine,
        owner: &MetadataQueryOwner,
        selection: &SetupNodeSelection<'_>,
        end: Instant,
    ) -> Result<SetupNodeObservation> {
        self.current(end)?;
        owner
            .assert_engine(engine)
            .map_err(WebsiteFactsError::Engine)?;
        let init = self.observe_init(selection.metadata, end)?;
        let top = owner
            .query(
                EngineQuery::ProviderTop(selection.site),
                end,
                selection.cancellation,
            )
            .map_err(WebsiteFactsError::Engine)?;
        let topology = ProviderTopology::decode(&top).map_err(WebsiteFactsError::Refused)?;
        need(
            topology.pairs().iter().any(|(pid, _)| pid == init.pid()),
            "ACTOR_SETUP_TOP_INIT",
        )?;
        let mut selected = None;
        for (pid, _) in topology.pairs() {
            let mut files = Descriptors::default();
            let body = self.setup_candidate(&mut files, pid, &init, selection, end);
            let candidate = match files.finish(body, &mut self.close_uncertain) {
                Err(WebsiteFactsError::Io(cause))
                    if cause.kind() == std::io::ErrorKind::NotFound && !self.close_uncertain =>
                {
                    continue;
                }
                other => other?,
            };
            if let Some(candidate) = candidate {
                need(selected.is_none(), "ACTOR_SETUP_UNIQUE_FIXED_NODE")?;
                selected = Some(candidate);
            }
        }
        let (node, argv) =
            selected.ok_or(WebsiteFactsError::Refused("ACTOR_SETUP_UNIQUE_FIXED_NODE"))?;
        need(
            self.observe_init(selection.metadata, end)? == init,
            "ACTOR_SETUP_INIT_CHANGED",
        )?;
        let mut files = Descriptors::default();
        let body = self.setup_candidate(&mut files, node.pid(), &init, selection, end);
        let final_node = files.finish(body, &mut self.close_uncertain)?;
        need(
            final_node
                .as_ref()
                .is_some_and(|(actual, args)| actual == &node && args == &argv),
            "ACTOR_SETUP_NODE_CHANGED",
        )?;
        Ok(SetupNodeObservation { init, node, argv })
    }
    fn setup_candidate(
        &self,
        files: &mut Descriptors,
        pid: &UnsignedInteger,
        init: &ProcessSnapshot,
        selection: &SetupNodeSelection<'_>,
        end: Instant,
    ) -> Result<Option<(ProcessSnapshot, Vec<PythonText>)>> {
        let process = read::process(files, pid, end)?;
        if process.namespaces() != init.namespaces() {
            return Ok(None);
        }
        let raw = read::bytes(files, pid, "cmdline", 65536, end)?;
        need(
            !raw.is_empty() && raw.len() <= 65536 && raw.last() == Some(&0),
            "ACTOR_SETUP_ARGV_BOUND",
        )?;
        let argv = raw[..raw.len() - 1]
            .split(|byte| *byte == 0)
            .map(|argument| {
                std::str::from_utf8(argument)
                    .map(PythonText::from_scalar_text)
                    .map_err(|_| WebsiteFactsError::Refused("ACTOR_SETUP_ARGV_ENCODING"))
            })
            .collect::<Result<Vec<_>>>()?;
        if !argv.starts_with(&selection.prefix.argv) {
            return Ok(None);
        }
        need(
            (1..=32).contains(&argv.len())
                && argv.iter().all(|value| {
                    !value.codepoints().is_empty() && value.codepoints().len() <= 4096
                }),
            "ACTOR_SETUP_ARGV_BOUND",
        )?;
        let status = read::bytes(files, pid, "status", 65536, end)?;
        reverie_contracts::resource_actor::require_peer_kernel_status(&status)
            .map_err(|cause| WebsiteFactsError::Refused(cause.code()))?;
        let status = std::str::from_utf8(&status)
            .map_err(|_| WebsiteFactsError::Refused("ACTOR_SETUP_PROCESS_IDENTITY"))?;
        for (field, expected) in [
            ("Uid:", selection.identity[0]),
            ("Gid:", selection.identity[1]),
        ] {
            let rows: Vec<_> = status
                .lines()
                .filter_map(|line| line.strip_prefix(field))
                .collect();
            need(rows.len() == 1, "ACTOR_SETUP_PROCESS_IDENTITY")?;
            let ids = rows[0].split_whitespace().collect::<Vec<_>>();
            need(
                ids.len() == 4 && ids.iter().all(|id| id.parse::<u32>() == Ok(expected)),
                "ACTOR_SETUP_PROCESS_IDENTITY",
            )?;
        }
        ancestry::walk(files, &process, init.pid(), end)?;
        need(
            read::process(files, pid, end)? == process
                && read::process(files, init.pid(), end)? == *init,
            "ACTOR_SETUP_PROCESS_CHANGED",
        )?;
        Ok(Some((process, argv)))
    }
}
