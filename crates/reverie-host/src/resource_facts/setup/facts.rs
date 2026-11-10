//! One original inactive installer's native observations. A copied document or
//! selected PID cannot construct this owner or authorize a file publication.
use super::*;
use crate::{
    engine_metadata::{
        CancellationToken, EngineError, EngineQuery, MetadataQueryOwner, ReadonlyEngine,
    },
    website_facts::*,
    worker_runtime::{WorkerRuntime, WorkerStopBudget},
};
use reverie_contracts::{
    reservation_engine::{ContainerRow, InventoryDecoder, ReservationConfiguration, inventory_ids},
    resource_actor::{
        ArtifactReference, EngineMetadata, EngineSelection, NativeResourceClientManifest,
        ProgramSelection, WebsiteImageProvenance, WebsiteProgramGraph, WebsiteSelection,
    },
};
use reverie_core::{PythonText, decimal::UnsignedInteger, operations::JournalDigest};
use std::{
    os::unix::fs::{FileTypeExt, MetadataExt},
    rc::Rc,
};
mod error;
mod guard;
mod observe;
pub use error::ActorSetupFactsError;
type FactsResult<T> = std::result::Result<T, ActorSetupFactsError>;
pub struct ActorSetupFacts {
    engine: ReadonlyEngine,
    cancellation: CancellationToken,
    query: MetadataQueryOwner,
    stop: WorkerStopBudget,
    config: EffectiveWorkerConfig,
    http: Option<WebsiteMetadataObserver>,
    input: ImmutableInputObserver,
    code: ImmutableCodeObserver,
    aliases: ImmutableAliasObserver,
    processes: WebsiteProcessObserver,
    bound: Option<Bound>,
    primary: Option<Rc<ActorSetupFactsError>>,
    cleanup: Option<Rc<ActorSetupFactsError>>,
    attempted: bool,
    close_attempted: bool,
    end: Instant,
}
struct Bound {
    document: InstalledFactsDocument,
    raw: Vec<u8>,
    graph: WebsiteProgramGraph,
    init: ProcessSnapshot,
    node: ProcessSnapshot,
}
impl ActorSetupFacts {
    pub(crate) fn publication_deadline(&self) -> Instant {
        self.deadline()
    }
    pub fn stop_budget(&self) -> WorkerStopBudget {
        self.stop.clone()
    }
    pub fn matches_configuration(&self, configuration: &EffectiveWorkerConfig) -> bool {
        reverie_contracts::worker_config::equivalent(&self.config, configuration)
            && self.config.session_resource_order() == configuration.session_resource_order()
    }
    pub fn capture(
        runtime: &WorkerRuntime,
        config: &EffectiveWorkerConfig,
        end: Instant,
    ) -> FactsResult<Self> {
        let engine = runtime.readonly();
        engine
            .assert_worker_runtime(runtime)
            .map_err(ActorSetupFactsError::Engine)?;
        ResourceActorSettings::capture(config).map_err(ActorSetupFactsError::Data)?;
        Ok(Self {
            query: engine.capture_query_owner(),
            cancellation: runtime.cancellation(),
            engine,
            stop: runtime.stop_budget(),
            config: config.clone(),
            http: None,
            input: Default::default(),
            code: Default::default(),
            aliases: Default::default(),
            processes: Default::default(),
            bound: None,
            primary: None,
            cleanup: None,
            attempted: false,
            close_attempted: false,
            end,
        })
    }
    pub fn observe(&mut self) -> std::result::Result<(), Rc<ActorSetupFactsError>> {
        if let Some(cause) = &self.primary {
            return Err(Rc::clone(cause));
        }
        if self.attempted || self.close_attempted {
            return Err(Rc::new(ActorSetupFactsError::Refused(
                "ACTOR_SETUP_FACTS_ALREADY_ATTEMPTED",
            )));
        }
        self.attempted = true;
        let body = self.prepare();
        self.retain(body)
    }
    pub fn assert_current(&mut self) -> std::result::Result<(), Rc<ActorSetupFactsError>> {
        if let Some(cause) = &self.primary {
            return Err(Rc::clone(cause));
        }
        if self.close_attempted {
            return Err(Rc::new(ActorSetupFactsError::Refused(
                "ACTOR_SETUP_FACTS_CLOSED",
            )));
        }
        let body = self.guard();
        self.retain(body)
    }
    pub fn document_bytes(&self) -> std::result::Result<&[u8], Rc<ActorSetupFactsError>> {
        if let Some(cause) = &self.primary {
            return Err(Rc::clone(cause));
        }
        self.bound
            .as_ref()
            .map(|bound| bound.raw.as_slice())
            .ok_or_else(|| {
                Rc::new(ActorSetupFactsError::Refused(
                    "ACTOR_SETUP_FACTS_UNOBSERVED",
                ))
            })
    }
    pub fn primary_error(&self) -> Option<&ActorSetupFactsError> {
        self.primary.as_deref()
    }
    pub fn cleanup_error(&self) -> Option<&ActorSetupFactsError> {
        self.cleanup.as_deref()
    }
    /// Component closure only. The original diagnostic stays retained and can
    /// never be spent as setup success or a terminal publication receipt.
    pub fn close(&mut self) -> std::result::Result<(), Rc<ActorSetupFactsError>> {
        if !self.close_attempted {
            self.close_attempted = true;
            let mut result = self
                .query
                .settle_owned(self.deadline())
                .map_err(ActorSetupFactsError::Engine);
            for observed in [
                self.input.assert_finalized(),
                self.code.assert_finalized(),
                self.aliases.assert_finalized(),
                self.processes.assert_finalized(),
                self.http
                    .as_ref()
                    .map_or(Ok(()), |http| http.assert_finalized()),
            ] {
                result = error::finalized(result, observed.map_err(ActorSetupFactsError::Website));
            }
            if let Err(cause) = result {
                self.cleanup = Some(Rc::new(cause));
            }
            if self.cleanup.is_none()
                && let Some(cause) = &self.primary
                && cause.has_unconfirmed_close()
            {
                self.cleanup = Some(Rc::clone(cause));
            }
        }
        self.cleanup
            .as_ref()
            .map_or(Ok(()), |cause| Err(Rc::clone(cause)))
    }
    fn retain(
        &mut self,
        body: FactsResult<()>,
    ) -> std::result::Result<(), Rc<ActorSetupFactsError>> {
        body.map_err(|cause| Rc::clone(self.primary.get_or_insert_with(|| Rc::new(cause))))
    }
    fn deadline(&self) -> Instant {
        self.stop
            .deadline()
            .map_or(self.end, |stop| self.end.min(stop))
    }
    fn current(&self) -> FactsResult<()> {
        require(
            Instant::now() < self.deadline(),
            "ACTOR_SETUP_FACTS_DEADLINE",
        )
    }
    fn query(&self, query: EngineQuery<'_>) -> FactsResult<String> {
        self.current()?;
        self.query
            .query(query, self.deadline(), &self.cancellation)
            .map_err(ActorSetupFactsError::Engine)
    }
    fn site(&self) -> FactsResult<ContainerRow> {
        let ids = inventory_ids(&self.query(EngineQuery::InventoryIds)?)
            .map_err(ActorSetupFactsError::Inventory)?;
        let mut decoder = InventoryDecoder::new(&ids).map_err(ActorSetupFactsError::Inventory)?;
        for batch in ids.chunks(32) {
            decoder
                .push(&self.query(EngineQuery::InspectBatch(batch))?)
                .map_err(ActorSetupFactsError::Inventory)?;
        }
        let rows = decoder.finish().map_err(ActorSetupFactsError::Inventory)?;
        let name = format!(
            "/{}",
            ReservationConfiguration::capture(self.config.clone())
                .server_container()
                .map_err(ActorSetupFactsError::Inventory)?
        );
        let mut sites = rows.rows().iter().filter(|row| row.name_is(&name));
        let selected = sites
            .next()
            .ok_or(ActorSetupFactsError::Refused("ACTOR_SETUP_CURRENT_SITE"))?;
        require(sites.next().is_none(), "ACTOR_SETUP_CURRENT_SITE")?;
        selected
            .running_header()
            .map_err(ActorSetupFactsError::Inventory)?;
        Ok(selected.clone())
    }
}
impl Drop for ActorSetupFacts {
    fn drop(&mut self) {
        if !self.close_attempted || self.cleanup.is_some() {
            // Keep every actual native owner on default/unknown destruction.
            // Replacing is safe: defaults own no descriptor or query ticket.
            let query = self.engine.capture_query_owner();
            std::mem::forget(std::mem::replace(&mut self.query, query));
            std::mem::forget(self.http.take());
            std::mem::forget(std::mem::take(&mut self.input));
            std::mem::forget(std::mem::take(&mut self.code));
            std::mem::forget(std::mem::take(&mut self.aliases));
            std::mem::forget(std::mem::take(&mut self.processes));
            std::mem::forget((self.bound.take(), self.primary.take(), self.cleanup.take()));
        }
    }
}
fn require(value: bool, code: &'static str) -> FactsResult<()> {
    value
        .then_some(())
        .ok_or(ActorSetupFactsError::Refused(code))
}
