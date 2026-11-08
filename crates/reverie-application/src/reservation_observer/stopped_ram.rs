//! Actual full-census/stopped inspection DATA. Neither stopped nor absent
//! means orphan/parent/cgroup/provider cleanup, capacity or launch permission.
use super::*;
use reverie_contracts::{
    reservation_engine::{InventoryDigest, StoppedFlag, StoppedRamDeclaration},
    resource_config, worker_config,
};
use reverie_store::storage_identity::StorageKind;
pub(crate) enum StoppedRamPresence {
    PresentStopped(StoppedRamPresent),
    Absent,
}
pub(crate) struct StoppedRamPresent {
    declaration: StoppedRamDeclaration,
    metadata: InventoryDigest,
    state: Vec<u8>,
}
impl StoppedRamPresent {
    pub(crate) fn declaration(&self) -> &StoppedRamDeclaration {
        &self.declaration
    }
    pub(crate) fn metadata_digest(&self) -> &InventoryDigest {
        &self.metadata
    }
    pub(crate) fn state_bytes(&self) -> &[u8] {
        &self.state
    }
}
pub(crate) struct StoppedRamObservation {
    presence: StoppedRamPresence,
    effective: EffectiveWorkerConfig,
    inventory: ObservedInventory,
}
impl StoppedRamObservation {
    pub(crate) fn presence(&self) -> &StoppedRamPresence {
        &self.presence
    }
    pub(crate) fn effective(&self) -> &EffectiveWorkerConfig {
        &self.effective
    }
    pub(crate) fn assert_same(&self, other: &Self) -> Result<()> {
        let same = match (&self.presence, &other.presence) {
            (StoppedRamPresence::Absent, StoppedRamPresence::Absent) => true,
            (
                StoppedRamPresence::PresentStopped(before),
                StoppedRamPresence::PresentStopped(after),
            ) => {
                before.declaration == after.declaration
                    && before.metadata == after.metadata
                    && before.state == after.state
            }
            _ => false,
        };
        need(
            same && self.inventory.equivalent(&other.inventory)
                && worker_config::equivalent(&self.effective, &other.effective),
            "RAM_STOPPED_SOURCE_CHANGED",
        )
    }
}
impl ObservationContext {
    pub(crate) fn assert_worker_runtime(
        &self,
        runtime: &reverie_host::worker_runtime::WorkerRuntime,
    ) -> Result<()> {
        self.observer.source.assert_worker_runtime(runtime)
    }
    pub(crate) fn observe_stopped_ram(
        &self,
        paths: &StoragePaths,
        end: Instant,
    ) -> Result<StoppedRamObservation> {
        need(
            paths.kind() == StorageKind::Employee,
            "RAM_STOPPED_EMPLOYEE_LEASE_REQUIRED",
        )?;
        self.check(end)?;
        let first = self.inventory_at(end)?;
        let effective = self
            .observer
            .source
            .effective_config(self.config.configuration().clone(), paths.session())?;
        let selected = self.selected_stopped_ram(&first, paths, &effective)?;
        let presence = match selected {
            None => StoppedRamPresence::Absent,
            Some(row) => {
                let state = self.stopped_state(&row, Some(end))?;
                need(
                    (state.status_is("exited") || state.status_is("created"))
                        && ![
                            StoppedFlag::Running,
                            StoppedFlag::Paused,
                            StoppedFlag::Restarting,
                            StoppedFlag::Dead,
                        ]
                        .into_iter()
                        .any(|flag| state.flag(flag)),
                    "RAM_STOPPED_NATIVE_STATE_REQUIRED",
                )?;
                let expected = resource_config::checked_effective_policy(&effective)
                    .map_err(|_| ObserverError::Refused("RAM_STOPPED_SOURCE_POLICY"))?;
                let policy = ObservedMemoryPolicy::from_effective(&effective)?;
                StoppedRamPresence::PresentStopped(StoppedRamPresent {
                    declaration: row
                        .data()
                        .stopped_ram_declaration(&expected, policy.as_ref())?,
                    metadata: row.data().snapshot_digest()?,
                    state: state.state_bytes(),
                })
            }
        };
        let second = self.inventory_at(end)?;
        need(
            first.equivalent(&second),
            "RAM_STOPPED_COMPLETE_CENSUS_CHANGED",
        )?;
        let repeated = self
            .observer
            .source
            .effective_config(self.config.configuration().clone(), paths.session())?;
        need(
            worker_config::equivalent(&effective, &repeated),
            "RAM_STOPPED_SOURCE_POLICY_CHANGED",
        )?;
        self.check(end)?;
        Ok(StoppedRamObservation {
            presence,
            effective,
            inventory: first,
        })
    }
    fn selected_stopped_ram<'a>(
        &self,
        rows: &'a ObservedInventory,
        paths: &StoragePaths,
        effective: &EffectiveWorkerConfig,
    ) -> Result<Option<ObservedRow<'a>>> {
        let deployment = self.config.deployment()?;
        let name = format!("/{deployment}-agent-{}", paths.session());
        let mut selected = None;
        let mut names = std::collections::BTreeSet::new();
        for row in rows.rows() {
            let data = row.data();
            let actual_name = data.stopped_ram_name()?;
            need(
                names.insert(actual_name.clone()),
                "RAM_STOPPED_DUPLICATE_NAME",
            )?;
            let named = actual_name == name;
            if data.label_is("reverie.worker", &deployment)? {
                need(
                    data.memory_session(&deployment)?.is_some(),
                    "RAM_STOPPED_UNTRACKED_SOURCE",
                )?;
            }
            let own_session = data.label_is("reverie.worker", &deployment)?
                && data.label_is("reverie.session", paths.session().as_str())?;
            if !named && !own_session {
                continue;
            }
            need(
                named
                    && own_session
                    && selected.is_none()
                    && data.label_is("reverie.employee", paths.identity())?
                    && data.label_is(
                        "reverie.worker-policy",
                        &worker_config::policy_digest(effective).to_hex(),
                    )?,
                "RAM_STOPPED_SOURCE_IDENTITY",
            )?;
            StoppedState::validate_ordinary(data)?;
            selected = Some(row);
        }
        Ok(selected)
    }
    pub(crate) fn settle_stopped_ram(&self, end: Instant) -> Result<()> {
        self.observer.source.settle_owned(end)
    }
}
