//! Actual protected STARTING intent. Only an existing retained claim can own
//! this process-local join; receipt/hash DATA cannot reconstruct it after death.
use super::preparation::RetainedPreparation;
use super::*;
use reverie_contracts::{
    profiles_v1,
    reservation_baseline::{self, StartIntentRecord},
    worker_config,
};
use reverie_core::{
    capacity::{CapacityCounter, pool_headroom_fits},
    ids::ProfileSessionId,
    operations::{Effect, JournalDigest, OperationState},
};
use reverie_store::{
    operations::TerminalJournalStamp,
    storage_identity::{self, StorageKind},
};
use std::sync::atomic::{AtomicBool, Ordering};
struct StartOwner {
    gate: Weak<Inner>,
    live: Weak<AtomicBool>,
    operation: JournalId,
    reservation: JournalId,
    target: ProfileSessionId,
    prepared: JournalDigest,
}
/// Minted after the real journal STARTING commit and exclusive intent receipt.
/// This is not API authorization or a Created/Started/completion result.
#[derive(Clone)]
pub struct ProtectedStartIntent(Arc<StartOwner>);
impl ProtectedStartIntent {
    pub(super) fn same_intent(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }
    pub fn operation_id(&self) -> &JournalId {
        &self.0.operation
    }
    pub fn target_session(&self) -> &ProfileSessionId {
        &self.0.target
    }
}
pub struct StartQualificationFacts {
    running: bool,
    operation: JournalId,
    target: ProfileSessionId,
}
impl StartQualificationFacts {
    pub(super) fn source_running(&self) -> bool {
        self.running
    }
    pub fn state(&self) -> &'static str {
        if self.running {
            "SOURCE_RUNNING_NO_LAUNCH"
        } else {
            "SOURCE_RELEASED_TARGET_NOT_CREATED"
        }
    }
    pub fn operation_id(&self) -> &JournalId {
        &self.operation
    }
    pub fn target_session(&self) -> &ProfileSessionId {
        &self.target
    }
}
impl RetainedPreparation {
    /// One attempt only. Every uncertain journal/receipt/finalizer result
    /// closes the retained store and keeps the existing durable reservation.
    pub fn begin_native_start(&mut self) -> Result<ProtectedStartIntent> {
        need(
            self.journal_available() && self.live.load(Ordering::Acquire),
            "RESOURCE_PREPARATION_ACTIVE_HANDLE_REQUIRED",
        )?;
        need(
            !self.start_attempted,
            "RESOURCE_NATIVE_START_ALREADY_ATTEMPTED",
        )?;
        match self.begin_start_attempt() {
            Ok(intent) => Ok(intent),
            Err(error) => Err(GateError::NativeStartIntentUncertain {
                cause: Box::new(finalized::<()>(Err(error), self.close_owned()).unwrap_err()),
            }),
        }
    }
    fn begin_start_attempt(&mut self) -> Result<ProtectedStartIntent> {
        let gate = self.gate.clone();
        let admission = self.admit_preparation()?;
        let body = (|| {
            gate.require_host_job_idle()?;
            self.assert_start_phase(OperationState::Prepared, 3)?;
            let prepared = self
                .view
                .record()
                .data()
                .last_receipt_digest
                .clone()
                .ok_or(GateError::Refused("RESOURCE_NATIVE_PREPARATION_CHANGED"))?;
            self.qualify_start_body(&prepared, true)?;
            // Preserve original precedence: failed probe does not latch an
            // attempted journal effect, while every actual effect is one-shot.
            self.start_attempted = true;
            self.view =
                self.journal_begin_effect(Effect::Start, self.view.record().data().version)?;
            let intent = ProtectedStartIntent(Arc::new(StartOwner {
                gate: Arc::downgrade(&gate),
                live: Arc::downgrade(&self.live),
                operation: self.operation_id().clone(),
                reservation: self.view.record().data().reservation_id.clone(),
                target: self.profile().binding().target_session().clone(),
                prepared,
            }));
            // Hashing occurs after STARTING, as in the original writer.
            let receipt = StartIntentRecord::from_observed_data(
                self.view.record(),
                self.original_baseline(),
            )?;
            reservation_control::publish_start_intent(gate.config()?.as_ref(), &receipt)?;
            self.start_owner = Some(intent.clone());
            Ok(intent)
        })();
        match body {
            Ok(intent) => {
                admission.finish_native_start(self, &intent)?;
                Ok(intent)
            }
            Err(error) => admission.conclude(Err(error)),
        }
    }
    /// Fresh readonly facts through the same live claim. It cannot revive a
    /// permit or resume/acknowledge any native action after a process restart.
    pub fn inspect_native_start(
        &self,
        intent: &ProtectedStartIntent,
    ) -> Result<StartQualificationFacts> {
        let admission = self.admit_preparation()?;
        admission.inspect_native_start(self, intent)
    }
    pub(super) fn qualify_intent(
        &self,
        intent: &ProtectedStartIntent,
        allow_running: bool,
    ) -> Result<StartQualificationFacts> {
        self.assert_start_phase(OperationState::Starting, 4)?;
        need(
            self.start_owner
                .as_ref()
                .is_some_and(|current| Arc::ptr_eq(&current.0, &intent.0))
                && intent
                    .0
                    .gate
                    .upgrade()
                    .is_some_and(|gate| Arc::ptr_eq(&gate, &self.gate))
                && intent.0.live.upgrade().is_some_and(|live| {
                    Arc::ptr_eq(&live, &self.live) && live.load(Ordering::Acquire)
                })
                && intent.0.operation == *self.operation_id()
                && intent.0.reservation == self.view.record().data().reservation_id
                && intent.0.target == *self.profile().binding().target_session(),
            "RESOURCE_NATIVE_PERMIT_CHANGED",
        )?;
        self.qualify_start_body(&intent.0.prepared, allow_running)
    }
    fn assert_start_phase(&self, state: OperationState, version: u64) -> Result<()> {
        need(
            self.journal_available()
                && self.live.load(Ordering::Acquire)
                && self.view.record().data().state == state
                && self.view.record().data().version.get() == version,
            "RESOURCE_NATIVE_PERMIT_CHANGED",
        )
    }
    fn qualify_start_body(
        &self,
        prepared: &JournalDigest,
        allow_running: bool,
    ) -> Result<StartQualificationFacts> {
        let gate = &self.gate;
        let (document, stamp) = gate
            .store()?
            .into_native_start_snapshot(&gate.scope, &self.view)?;
        let rows = gate.guard(None)?;
        let native = gate.native_context()?;
        let baseline = self.original_baseline();
        let mut matching = rows
            .rows()
            .filter(|row| row.data().id() == baseline.native().container_id());
        let old = matching
            .next()
            .ok_or(GateError::Refused("RESOURCE_NATIVE_OLD_CID_REQUIRED"))?;
        need(
            matching.next().is_none(),
            "RESOURCE_NATIVE_OLD_CID_REQUIRED",
        )?;
        let running = baseline.start_source_running(old.data())?;
        if running {
            need(allow_running, "RESOURCE_NATIVE_OLD_LAPTOP_RUNNING")?;
            let limits = native.limits(&old)?;
            let storage = native.storage(&old, self.source_paths())?;
            baseline.assert_original_native(&limits, &storage)?;
        } else {
            native.old_source_released(&old, baseline)?;
        }
        let current: Vec<_> = rows.rows().collect();
        let original: Vec<_> = self.terminal.native.rows().collect();
        baseline.assert_start_peers(
            current.iter().map(|row| row.data()),
            original.iter().map(|row| row.data()),
        )?;
        let capacity = native.capacity(&rows)?;
        let crate::reservation_observer::WebsiteBinding::Running(site) = capacity.website() else {
            return Err(GateError::Refused("RESOURCE_NATIVE_CAPACITY_CHANGED"));
        };
        baseline.assert_start_capacity(site, capacity.budget())?;
        baseline.assert_start_commitments(capacity.commitments(), running)?;
        let retained = gate.retained_for_native_start(&document, self)?;
        if !running {
            need(
                pool_headroom_fits(
                    CapacityCounter::from_integer(capacity.budget())?,
                    CapacityCounter::from_integer(capacity.total())?,
                    CapacityCounter::from_integer(&retained)?,
                    CapacityCounter::try_new(
                        self.view
                            .record()
                            .data()
                            .request
                            .requested_memory_bytes
                            .get(),
                    )?,
                )?,
                "RESERVATION_CAPACITY_EXHAUSTED",
            )?;
        }
        let target = self.profile().binding().target_session();
        let paths = storage_identity::storage_paths(&gate.identity, target)?;
        need(
            paths.kind() == StorageKind::Employee
                && paths.employee() == Some(self.profile().binding().employee())
                && storage_identity::storage_start_allowed(&gate.identity, &paths)?,
            "RESOURCE_NATIVE_TARGET_BINDING_CHANGED",
        )?;
        native.original_target_storage(&paths, baseline)?;
        self.finish_start_metadata(&native, &rows, &stamp, prepared, &paths)?;
        Ok(StartQualificationFacts {
            running,
            operation: self.operation_id().clone(),
            target: target.clone(),
        })
    }
    fn finish_start_metadata(
        &self,
        native: &ObservationContext,
        rows: &ObservedInventory,
        stamp: &TerminalJournalStamp,
        prepared: &JournalDigest,
        paths: &storage_identity::StoragePaths,
    ) -> Result<()> {
        let gate = &self.gate;
        native.original_accounts_current(self.original_baseline().runtime())?;
        let policy = self
            .policy
            .as_ref()
            .ok_or(GateError::Refused("RESOURCE_NATIVE_PREPARATION_CHANGED"))?;
        native.custody_policy(&policy.binding, None)?;
        need(
            gate.guard(None)?.equivalent(rows),
            "RESOURCE_NATIVE_INVENTORY_CHANGED",
        )?;
        self.assert_policy_current()?;
        need(
            worker_config::equivalent(
                gate.config()?.configuration(),
                policy.candidate.configuration(),
            ),
            "RESOURCE_NATIVE_CONFIG_CHANGED",
        )?;
        let publication = self
            .publication
            .as_ref()
            .ok_or(GateError::Refused("RESOURCE_NATIVE_PHASE_CHANGED"))?;
        reservation_control::assert_native_publication(
            gate.config()?.as_ref(),
            self.operation_id(),
            &publication.signature,
            &publication.receipt,
        )?;
        let receipt = reservation_control::read_prepared_policy(
            gate.config()?.as_ref(),
            self.operation_id(),
        )?;
        reservation_baseline::assert_prepared_for_start(
            &receipt,
            self.view.record(),
            self.profile(),
            policy.candidate.configuration(),
            prepared,
        )?;
        stamp.assert_native_start_named_current()?;
        need(
            gate.profile(self.profile().binding().employee())?
                .as_ref()
                .is_some_and(|profile| profiles_v1::equivalent(profile, self.profile())),
            "RESOURCE_NATIVE_PROFILE_CHANGED",
        )?;
        need(
            publication
                .receipt
                .after_employee()
                .still_current(&storage_identity::read_company_metadata(&gate.identity)?)?,
            "RESOURCE_NATIVE_TARGET_BINDING_CHANGED",
        )?;
        need(
            storage_identity::storage_paths(&gate.identity, paths.session())? == *paths
                && storage_identity::storage_start_allowed(&gate.identity, paths)?,
            "RESOURCE_NATIVE_TARGET_BINDING_CHANGED",
        )?;
        need(
            self.live.load(Ordering::Acquire),
            "RESOURCE_PREPARATION_ACTIVE_HANDLE_REQUIRED",
        )
    }
}
