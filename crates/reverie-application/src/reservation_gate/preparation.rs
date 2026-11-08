//! Actual retained canonical claim + original native baseline producer.
//! Phase extensions publish PREPARING, stage and commit the protected policy
//! file. Engine start/stop, source replacement and completion remain unavailable
//! until their complete native producers and retained ownership are implemented.
use super::claim::{ClaimedContext, TerminalClaim};
use super::*;
use crate::reservation_observer::WebsiteBinding;
use reverie_contracts::{
    reservation_baseline::{OriginalBaselineFields, OriginalSourceBaseline},
    reservation_observation::{self, PoolWebsite},
    worker_config::EffectiveWorkerConfig,
};
use reverie_core::operations::JournalDigest;
use reverie_store::{
    operations::OperationHandle,
    storage_identity::{self, StorageKind, StoragePaths},
};

/// Nonserializable process-local owner produced only by an actual held Gate
/// claim and native capture. Data accessors convey no permission to effects.
/// Dropping/closing retains the durable reservation and target-session fence.
pub struct RetainedPreparation {
    pub(super) draft: reverie_contracts::reservation_draft::DraftRecord,
    pub(super) gate: Arc<Inner>,
    pub(super) store: Option<OperationStore>,
    pub(super) handle: Option<OperationHandle>,
    pub(super) scope_guard: Option<Arc<super::guard::InstalledGuard>>,
    pub(super) ram_journal: Option<super::ram_journal::SharedJournal>,
    pub(super) view: OperationView,
    pub(super) terminal: TerminalClaim,
    before: EffectiveWorkerConfig,
    paths: StoragePaths,
    baseline: OriginalSourceBaseline,
    pub(super) original_source: Option<crate::installing_broker::source::RegisteredSource>,
    pub(super) source_stop_phase: super::preparation_stop::SourceStopPhase,
    pub(super) preparing_attempted: bool,
    pub(super) start_attempted: bool,
    pub(super) start_owner: Option<super::preparation_start::ProtectedStartIntent>,
    pub(super) publication: Option<super::preparation_phase::PublicationBoundary>,
    pub(super) published: bool,
    pub(super) policy: Option<super::preparation_policy::PolicyPhase>,
    pub(super) live: Arc<std::sync::atomic::AtomicBool>,
    pub(super) ram_authority: Option<Arc<super::ram_authority::RamJournalAuthority>>,
}
impl RetainedPreparation {
    pub(super) fn admit_preparation(&self) -> Result<admission::Admission> {
        let bounds = self
            .ram_authority
            .as_ref()
            .map_or_else(AdmissionBounds::default, |authority| authority.bounds());
        let mut admission = self.gate.admit(bounds)?;
        if let Some(authority) = &self.ram_authority
            && let Err(error) = admission.bind_ram_authority(authority)
        {
            return admission.conclude(Err(error));
        }
        if let Some(journal) = &self.ram_journal {
            let resumed = (|| {
                admission.retain_ram_journal(self, journal.clone())?;
                journal
                    .lock()
                    .map_err(|_| GateError::Refused("RAM_JOURNAL_UNAVAILABLE"))?
                    .resume(super::guard::installed(&self.gate))
            })();
            if let Err(error) = resumed {
                return admission.conclude(Err(error));
            }
        }
        Ok(admission)
    }
    pub(crate) fn attach_original_source(
        &mut self,
        source: crate::installing_broker::source::RegisteredSource,
    ) {
        self.original_source = Some(source);
    }
    pub fn operation(&self) -> &OperationView {
        &self.view
    }
    pub fn operation_id(&self) -> &JournalId {
        &self.view.record().data().id
    }
    pub fn scope(&self) -> &OperationScope {
        &self.gate.scope
    }
    pub fn profile(&self) -> &reverie_core::profiles::ResourceProfile {
        &self.terminal.profile
    }
    pub fn source_configuration(&self) -> &EffectiveWorkerConfig {
        &self.before
    }
    pub fn source_paths(&self) -> &StoragePaths {
        &self.paths
    }
    pub fn original_baseline(&self) -> &OriginalSourceBaseline {
        &self.baseline
    }
    /// Checked exactly-once owned-store close; this does not release capacity,
    /// clear a target fence, acknowledge completion or permit retry.
    pub fn close(mut self) -> Result<()> {
        self.close_owned()
    }
    pub(super) fn close_owned(&mut self) -> Result<()> {
        self.live.store(false, std::sync::atomic::Ordering::Release);
        if let Some(journal) = &self.ram_journal {
            return journal
                .lock()
                .map_err(|_| GateError::Refused("RAM_JOURNAL_UNAVAILABLE"))?
                .close_component();
        }
        match self.store.take() {
            Some(store) => store.close().map_err(Into::into),
            None => Ok(()),
        }
    }
}
impl ReservationGate {
    /// Fixed private preparation entry. The draft hash binds DATA only; fresh
    /// actual admission, canonical claim and native baseline are mandatory.
    pub fn retain_draft(
        &self,
        id: &JournalId,
        digest: &JournalDigest,
    ) -> Result<RetainedPreparation> {
        self.enter_resource_draft(id, digest)?
            .retain()
            .map_err(|failure| failure.cause)
    }
    pub(super) fn retain_context(
        &self,
        admission: super::admission::Admission,
        context: ClaimedContext,
        draft: reverie_contracts::reservation_draft::DraftRecord,
    ) -> Result<RetainedPreparation> {
        let body = self.capture_preparation_context(&context);
        match body {
            Err(error) => admission.conclude(finalized(
                Err(error),
                context.store.close().map_err(Into::into),
            )),
            Ok(captured) => {
                if let Err(error) = admission.finish_claim(&context.terminal) {
                    return finalized(Err(error), context.store.close().map_err(Into::into));
                }
                Ok(self.retained_preparation(context, draft, captured))
            }
        }
    }
}

pub(super) struct CapturedPreparation {
    before: EffectiveWorkerConfig,
    paths: StoragePaths,
    baseline: OriginalSourceBaseline,
}
impl ReservationGate {
    pub(super) fn capture_preparation_context(
        &self,
        context: &ClaimedContext,
    ) -> Result<CapturedPreparation> {
        (|| {
            need(
                context.handle.is_some(),
                "RESERVATION_REPLAY_HAS_NO_ACTIVE_HANDLE",
            )?;
            let before = self.inner.config()?.configuration().clone();
            let binding = context.terminal.profile.binding();
            let paths =
                storage_identity::storage_paths(&self.inner.identity, binding.current_session())?;
            need(
                paths.kind() == StorageKind::Employee
                    && paths.identity() == binding.employee().as_str(),
                "RESOURCE_PREPARATION_STORAGE_CHANGED",
            )?;
            let baseline = self.inner.capture_original(&context.terminal, &paths)?;
            Ok(CapturedPreparation {
                before,
                paths,
                baseline,
            })
        })()
    }
    pub(super) fn retained_preparation(
        &self,
        context: ClaimedContext,
        draft: reverie_contracts::reservation_draft::DraftRecord,
        captured: CapturedPreparation,
    ) -> RetainedPreparation {
        let CapturedPreparation {
            before,
            paths,
            baseline,
        } = captured;
        RetainedPreparation {
            draft,
            gate: self.inner.clone(),
            store: Some(context.store),
            handle: context.handle,
            scope_guard: Some(context.scope_guard),
            ram_journal: None,
            view: context.view,
            terminal: context.terminal,
            before,
            paths,
            baseline,
            original_source: None,
            source_stop_phase: super::preparation_stop::SourceStopPhase::Idle,
            preparing_attempted: false,
            start_attempted: false,
            start_owner: None,
            publication: None,
            published: false,
            policy: None,
            live: Arc::new(std::sync::atomic::AtomicBool::new(true)),
            ram_authority: None,
        }
    }
}

impl Drop for RetainedPreparation {
    fn drop(&mut self) {
        self.live.store(false, std::sync::atomic::Ordering::Release);
    }
}
impl Inner {
    fn capture_original(
        &self,
        claim: &TerminalClaim,
        paths: &StoragePaths,
    ) -> Result<OriginalSourceBaseline> {
        let deployment = self.config()?.deployment()?;
        let mut source = None;
        for row in claim.native.rows() {
            if row.data().label_is("reverie.worker", &deployment)?
                && row.data().label_is(
                    "reverie.session",
                    claim.profile.binding().current_session().as_str(),
                )?
            {
                need(source.is_none(), "RESOURCE_NATIVE_SOURCE_REQUIRED")?;
                source = Some(row);
            }
        }
        let source = source.ok_or(GateError::Refused("RESOURCE_NATIVE_SOURCE_REQUIRED"))?;
        let native = self.native_context()?;
        let limits = native.limits(&source)?;
        let storage = native.storage(&source, paths)?;
        let capacity = native.capacity(&claim.native)?;
        let observed = claim.observed.fields();
        need(
            reservation_observation::claim_source_binding_digest(
                &claim.employee,
                &limits,
                &storage,
                &claim.profile,
            )? == observed.source_binding,
            "RESOURCE_NATIVE_SOURCE_CHANGED",
        )?;
        let WebsiteBinding::Running(site) = capacity.website() else {
            return Err(GateError::Refused("RESOURCE_NATIVE_CAPACITY_CHANGED"));
        };
        need(
            reservation_observation::pool_revision_digest(
                &observed.pool,
                capacity.budget(),
                PoolWebsite::Running(site),
                self.option.host_reserve_mib(),
                capacity.commitments(),
            )? == observed.pool_revision,
            "RESOURCE_NATIVE_CAPACITY_CHANGED",
        )?;
        let runtime = native.original_runtime_tail(&source, &limits)?;
        Ok(OriginalSourceBaseline::from_observed_data(
            OriginalBaselineFields {
                source: source.data(),
                native: &limits,
                storage: &storage,
                site,
                commitments: capacity.commitments(),
                total: capacity.total(),
                budget: capacity.budget(),
                runtime: &runtime,
            },
        ))
    }
}
