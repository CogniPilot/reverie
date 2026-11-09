//! Native-origin census and original registry observations. This is not a
//! drained certificate or proof that a Busy/native-unknown resource is closed.
use super::*;
use crate::reservation_observer::{ObservedInventory, ObservedRow};
use reverie_contracts::{resource_config::ResourceIdentitySettings, storage_identity::Metadata};
use reverie_store::storage_identity::{self, ProviderRuntimeObservation, StorageIdentityConfig};
use std::collections::BTreeSet;

pub(super) struct Coverage<'a> {
    broker: &'a InstallingBroker,
    snapshot: Arc<ValidatedWorkerSnapshot>,
    company: Metadata,
    company_digest: String,
    inventory: ObservedInventory,
    lifecycle: lifecycle::FleetRegistrationSnapshot<'a>,
    storage: storage::StorageFleetSnapshot,
    rows: serde_json::Value,
    members: serde_json::Value,
    runtimes: Vec<ProviderRuntimeObservation>,
}
impl<'a> Coverage<'a> {
    pub(super) fn capture(frame: &mut Frame<'a>, end: Instant) -> Result<Self> {
        let broker = frame.broker;
        let snapshot = frame
            .snapshot
            .as_ref()
            .ok_or(Cause::Refused("FLEET_PREVIEW_SNAPSHOT_REQUIRED"))?
            .clone();
        let company = read_company(frame)?;
        let company_digest = company
            .company_snapshot_digest()
            .map_err(ResourceActorError::from)?;
        let lifecycle = broker.installed.capture_fleet_preview()?;
        let storage = broker.storage.capture_fleet_preview(&company)?;
        let result = context(frame)?.custody(Some(end)).map_err(Into::into);
        let inventory = frame.retain_stateless_result(result)?;
        let (rows, members, runtimes) = observe_rows(frame, &inventory, &lifecycle, &storage, end)?;
        let owner = Self {
            broker,
            snapshot,
            company,
            company_digest,
            inventory,
            lifecycle,
            storage,
            rows,
            members,
            runtimes,
        };
        owner.assert_current(frame, end)?;
        Ok(owner)
    }
    pub(super) fn assert_current(&self, frame: &mut Frame<'_>, end: Instant) -> Result<()> {
        if !std::ptr::eq(self.broker, frame.broker)
            || !frame
                .snapshot
                .as_ref()
                .is_some_and(|s| Arc::ptr_eq(s, &self.snapshot))
        {
            return Err(Cause::Refused("FLEET_PREVIEW_CONTEXT_CHANGED"));
        }
        assert_inventory_origin(frame, &self.inventory)?;
        self.assert_registries_current(frame)?;
        let result = context(frame)?.custody(Some(end)).map_err(Into::into);
        let current = frame.retain_stateless_result(result)?;
        if !self.inventory.equivalent(&current) {
            return Err(Cause::Refused("FLEET_PREVIEW_CENSUS_CHANGED"));
        }
        let (rows, members, _) =
            observe_rows(frame, &current, &self.lifecycle, &self.storage, end)?;
        if rows != self.rows || members != self.members {
            return Err(Cause::Refused("FLEET_PREVIEW_BIRTH_CHANGED"));
        }
        let identity = identity(frame)?;
        for runtime in &self.runtimes {
            let result = runtime
                .assert_current(&identity)
                .map_err(GateError::from)
                .map_err(Into::into);
            frame.retain_stateless_result(result)?;
        }
        // Native census/process/runtime reads may wait. Recheck the SAME
        // original registrations and complete company after those waits.
        self.assert_registries_current(frame)?;
        Ok(())
    }
    fn assert_registries_current(&self, frame: &mut Frame<'_>) -> Result<()> {
        let company = read_company(frame)?;
        if !self.company.equivalent(&company)
            || company
                .company_snapshot_digest()
                .map_err(ResourceActorError::from)?
                != self.company_digest
        {
            return Err(Cause::Refused("FLEET_PREVIEW_COMPANY_CHANGED"));
        }
        self.lifecycle.assert_current(&frame.broker.installed)?;
        self.storage
            .assert_current(&frame.broker.storage, &company)?;
        if !Arc::ptr_eq(&self.snapshot, &frame.broker.configuration()?) {
            return Err(Cause::Refused("FLEET_PREVIEW_CONFIGURATION_CHANGED"));
        }
        Ok(())
    }
    pub(super) fn selection(
        &self,
        binding: &UnpreparedOfferBinding,
    ) -> Result<reverie_contracts::reservation_control::PoolTransitionSelection> {
        self.bound_selection(binding, None)
    }
    pub(super) fn qualified_selection(
        &self,
        binding: &UnpreparedOfferBinding,
        inputs: &inputs::PoolInputs,
    ) -> Result<reverie_contracts::reservation_control::PoolTransitionSelection> {
        self.bound_selection(binding, Some(inputs))
    }
    fn bound_selection(
        &self,
        binding: &UnpreparedOfferBinding,
        inputs: Option<&inputs::PoolInputs>,
    ) -> Result<reverie_contracts::reservation_control::PoolTransitionSelection> {
        let mut covered = serde_json::json!({"rows":self.rows,"company":self.company_digest,"lifecycle":self.lifecycle.data(),"storage":self.storage.rows(),
            "offerNonce":binding.offer_nonce().as_str(),"requestDigest":binding.request_digest().as_str(),"publication":binding.publication().digest()});
        if let Some(inputs) = inputs {
            covered
                .as_object_mut()
                .expect("closed coverage object")
                .insert("poolImageInputs".into(), inputs.binding_data());
        }
        Ok(
            reverie_contracts::reservation_control::PoolTransitionSelection::new(
                reverie_host::resource_facts::fresh_owner_nonce()
                    .map_err(ResourceActorError::from)?,
                reverie_host::resource_facts::fresh_owner_nonce()
                    .map_err(ResourceActorError::from)?,
                json_digest(&self.members)?,
                digest(binding.policy_bytes()),
                json_digest(&covered)?,
                reverie_core::operations::JournalDigest::parse(
                    &reverie_contracts::worker_config::config_digest(self.snapshot.configuration())
                        .to_hex(),
                )
                .expect("config SHA256"),
            ),
        )
    }
}
fn context<'frame>(frame: &'frame Frame<'_>) -> Result<&'frame ObservationContext> {
    frame
        .context
        .as_ref()
        .ok_or(Cause::Refused("FLEET_PREVIEW_CONTEXT_REQUIRED"))
}
pub(super) fn assert_inventory_origin(
    frame: &Frame<'_>,
    inventory: &ObservedInventory,
) -> Result<()> {
    context(frame)?
        .assert_inventory_origin(inventory)
        .map_err(ResourceActorError::from)?;
    Ok(())
}
fn identity(frame: &Frame<'_>) -> Result<StorageIdentityConfig> {
    let snapshot = frame
        .snapshot
        .as_ref()
        .ok_or(Cause::Refused("FLEET_PREVIEW_SNAPSHOT_REQUIRED"))?;
    let settings = ResourceIdentitySettings::capture_worker_config(snapshot.configuration())
        .map_err(GateError::from)?;
    Ok(StorageIdentityConfig::capture_worker_settings(&settings))
}
fn read_company(frame: &mut Frame<'_>) -> Result<Metadata> {
    let result = storage_identity::read_company_metadata(&identity(frame)?)
        .map_err(GateError::from)
        .map_err(Into::into);
    Ok(frame.retain_stateless_result(result)?)
}
fn observe_rows(
    frame: &mut Frame<'_>,
    inventory: &ObservedInventory,
    lifecycle: &lifecycle::FleetRegistrationSnapshot<'_>,
    storage: &storage::StorageFleetSnapshot,
    end: Instant,
) -> Result<(
    serde_json::Value,
    serde_json::Value,
    Vec<ProviderRuntimeObservation>,
)> {
    assert_inventory_origin(frame, inventory)?;
    let deployment = frame
        .snapshot
        .as_ref()
        .expect("bound snapshot")
        .envelope()
        .base()
        .deployment()
        .to_owned();
    let mut rows = Vec::new();
    let mut members = Vec::new();
    let mut runtimes = Vec::new();
    let mut sessions = BTreeSet::new();
    for row in inventory.rows() {
        let data = row.data();
        rows.push((
            data.id().as_str().to_owned(),
            data.snapshot_digest().map_err(GateError::from)?.to_hex(),
        ));
        if !data
            .image_maintenance_member(&deployment)
            .map_err(GateError::from)?
            || !data.running().map_err(GateError::from)?
        {
            continue;
        }
        let session = data
            .memory_session(&deployment)
            .map_err(GateError::from)?
            .ok_or(Cause::Refused("FLEET_PREVIEW_UNCOVERED_MEMBER"))?;
        if !sessions.insert(session.clone()) {
            return Err(Cause::Refused("FLEET_PREVIEW_AMBIGUOUS_MEMBER"));
        }
        let paths = storage
            .paths_for_session(&session)
            .or_else(|| lifecycle.paths_for_session(&session))
            .ok_or(Cause::Refused("FLEET_PREVIEW_UNCOVERED_MEMBER"))?;
        let member = observe_member(frame, &row, paths, end)?;
        runtimes.push(member.1);
        members.push((session.as_str().to_owned(), member.0));
    }
    rows.sort_by(|a, b| a.0.cmp(&b.0));
    members.sort_by(|a, b| a.0.cmp(&b.0));
    Ok((
        serde_json::json!(rows),
        serde_json::json!(members),
        runtimes,
    ))
}
fn observe_member(
    frame: &mut Frame<'_>,
    row: &ObservedRow<'_>,
    paths: &storage_identity::StoragePaths,
    end: Instant,
) -> Result<(serde_json::Value, ProviderRuntimeObservation)> {
    let identity = identity(frame)?;
    let result = identity
        .observe_provider_runtime(paths)
        .map_err(GateError::from)
        .map_err(Into::into);
    let runtime = frame.retain_stateless_result(result)?;
    let result = context(frame)?.storage(row, paths).map_err(Into::into);
    let storage = frame.retain_stateless_result(result)?;
    let result = context(frame)?.limits(row).map_err(Into::into);
    let limits = frame.retain_stateless_result(result)?;
    let process = frame
        .context
        .as_ref()
        .expect("same original context")
        .provider_process(&mut frame.processes, row, end)
        .map_err(ResourceActorError::from)?;
    let result = runtime
        .assert_current(&identity)
        .map_err(GateError::from)
        .map_err(Into::into);
    frame.retain_stateless_result(result)?;
    let process = serde_json::json!({"init":[process.init().pid().as_str(),process.init().start().as_str()],
        "pane":process.pane_process().map(|p|(p.pid().as_str(),p.start().as_str())),"children":process.pane_children().iter().map(|p|(p.pid().as_str(),p.start().as_str())).collect::<Vec<_>>(),"dead":process.pane_dead()});
    Ok((
        serde_json::json!({"cid":row.data().id().as_str(),"limits":limits.canonical_bytes(),"storage":storage.canonical_bytes(),"process":process}),
        runtime,
    ))
}
fn digest(bytes: &[u8]) -> reverie_core::operations::JournalDigest {
    use sha2::{Digest, Sha256};
    reverie_core::operations::JournalDigest::parse(&format!("{:x}", Sha256::digest(bytes)))
        .expect("SHA256")
}
fn json_digest(value: &serde_json::Value) -> Result<reverie_core::operations::JournalDigest> {
    Ok(digest(
        &serde_json::to_vec(value).map_err(|_| Cause::Refused("FLEET_PREVIEW_ENCODING"))?,
    ))
}
