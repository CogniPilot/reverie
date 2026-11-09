//! Same-Runtime existing typed provider observer. No new probe or PID selector.
use super::*;
use reverie_contracts::reservation_engine::InventoryDecoder;
use reverie_core::ids::ContainerId;
use reverie_host::{
    engine_metadata::{CancellationToken, EngineQuery, MetadataQueryOwner, ReadonlyEngine},
    website_facts::{ProcessSnapshot, WebsiteFactsError, WebsiteProcessObserver},
};

enum ReadFailure {
    Metadata(reverie_host::engine_metadata::EngineError),
    Process(WebsiteFactsError),
}
impl ReadFailure {
    fn message(&self) -> String {
        match self {
            Self::Metadata(error) => error.to_string(),
            Self::Process(error) => error.to_string(),
        }
    }
}
pub(in crate::installing_broker::service::tests::native_cold::transaction) struct ProviderReader {
    engine: ReadonlyEngine,
    owner: MetadataQueryOwner,
    process: WebsiteProcessObserver,
    failures: Vec<ReadFailure>,
}
impl ProviderReader {
    pub(in crate::installing_broker::service::tests::native_cold::transaction) fn new(
        engine: ReadonlyEngine,
    ) -> Self {
        let owner = engine.capture_query_owner();
        Self {
            engine,
            owner,
            process: Default::default(),
            failures: Vec::new(),
        }
    }
    fn retain_failure(&mut self, error: ReadFailure) -> String {
        let message = error.message();
        self.failures.push(error);
        message
    }
    pub(in crate::installing_broker::service::tests::native_cold::transaction) fn observe(
        &mut self,
        id: &ContainerId,
        end: Instant,
        cancel: &CancellationToken,
    ) -> Result<(ProcessSnapshot, ProcessSnapshot, ProcessSnapshot)> {
        let ids = std::slice::from_ref(id);
        let raw = match self
            .owner
            .query(EngineQuery::InspectBatch(ids), end, cancel)
        {
            Ok(raw) => raw,
            Err(error) => return Err(self.retain_failure(ReadFailure::Metadata(error))),
        };
        let mut decoder = InventoryDecoder::new(ids).map_err(|e| e.to_string())?;
        decoder.push(&raw).map_err(|e| e.to_string())?;
        let rows = decoder.finish().map_err(|e| e.to_string())?;
        require(rows.rows().len() == 1, "one original provider row")?;
        let observed = match self.process.observe_provider(
            &self.engine,
            &self.owner,
            &rows.rows()[0],
            end,
            cancel,
        ) {
            Ok(observed) => observed,
            Err(error) => return Err(self.retain_failure(ReadFailure::Process(error))),
        };
        require(
            !observed.pane_dead() && observed.live_child() && observed.pane_children().len() == 1,
            "one actual native controller command child must remain live",
        )?;
        let pane = observed
            .pane_process()
            .ok_or("actual controller process missing")?;
        Ok((
            observed.init().clone(),
            pane.clone(),
            observed.pane_children()[0].clone(),
        ))
    }
    pub(in crate::installing_broker::service::tests::native_cold::transaction) fn close(
        &mut self,
        end: Instant,
    ) -> Result<()> {
        let metadata = self.owner.settle_owned(end);
        let process = self.process.assert_finalized();
        let mut errors = Vec::new();
        if let Err(error) = metadata {
            errors.push(self.retain_failure(ReadFailure::Metadata(error)));
        }
        if let Err(error) = process {
            errors.push(self.retain_failure(ReadFailure::Process(error)));
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("; "))
        }
    }
}
