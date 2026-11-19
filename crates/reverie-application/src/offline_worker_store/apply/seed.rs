//! From fenced helper creation to a durable, fully settled seed receipt.
use super::{Attempt, Fence, Journal, Lease, LocalEngine, Result, observe};
use reverie_contracts::worker_nix::offline_qualification::mounts::{SeedHelper, SeedState};
use reverie_core::ids::ContainerId;
use reverie_host::worker_nix::offline_store_engine::Query;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    thread,
    time::{Duration, Instant},
};

impl Attempt<'_> {
    pub(super) fn seed(
        &self,
        engine: &LocalEngine,
        lease: &Lease,
        fence: &Fence,
        journal: &Journal,
    ) -> Result<Vec<u8>> {
        let seat = &self.initial.seat;
        let store = observe::path_text(seat.paths.nix());
        let helper = self.seed_helper(&store);
        self.check_seed_admission(lease, fence, journal)?;
        let cid = engine.create(&seat.helper, self.operation)?;
        if !matches!(
            self.inspect_helper(engine, &helper, &cid)?,
            SeedState::Created
        ) {
            return Err("new seed helper state changed before start".into());
        }
        self.check_seed_admission(lease, fence, journal)?;
        engine.start(&cid)?;
        self.wait(engine, lease, fence, &helper, &cid)?;
        let after = observe::capture_profiles(seat.paths.home(), seat.paths.nix())?;
        let target = &self.initial.target.target;
        after.verify_seed(&self.initial.profiles, target.base_target())?;
        lease.check_closure(target)?;
        self.check_cohort()?;
        lease.check()?;
        fence.check()?;
        journal.check()?;
        engine.remove(&cid)?;
        self.check_removal(engine, &cid)?;
        self.check_cohort()?;
        lease.check()?;
        fence.check()?;
        journal.check()?;
        let receipt = self.receipt(&cid, &after.bytes()?)?;
        journal.receipt(&receipt)?;
        fence.check()?;
        journal.check()?;
        Ok(receipt)
    }

    fn check_seed_admission(&self, lease: &Lease, fence: &Fence, journal: &Journal) -> Result<()> {
        journal.check()?;
        self.require_fresh_admission()?;
        lease.check()?;
        fence.check()?;
        Ok(self
            .initial
            .target
            .target
            .require_unexpired(super::epoch())?)
    }

    fn wait(
        &self,
        engine: &LocalEngine,
        lease: &Lease,
        fence: &Fence,
        helper: &SeedHelper<'_>,
        cid: &ContainerId,
    ) -> Result<()> {
        let deadline = Instant::now() + Duration::from_secs(300);
        loop {
            if Instant::now() >= deadline {
                return Err("seed deadline expired; completion unconfirmed".into());
            }
            lease.check()?;
            fence.check()?;
            self.require_fresh_admission()?;
            let observed = self.inspect_helper(engine, helper, cid)?;
            if Instant::now() >= deadline {
                return Err("seed deadline expired; completion unconfirmed".into());
            }
            match observed {
                SeedState::Completed => return Ok(()),
                SeedState::Running => thread::sleep(Duration::from_millis(250)),
                SeedState::Created | SeedState::Failed => {
                    return Err("helper failed or never started; diagnostics/fence retained".into());
                }
            }
        }
    }

    fn inspect_helper(
        &self,
        engine: &LocalEngine,
        helper: &SeedHelper<'_>,
        cid: &ContainerId,
    ) -> Result<SeedState> {
        let raw = engine.read(
            self.initial.target.target.engine_socket(),
            Query::Inspect(vec![cid.clone()]),
        )?;
        Ok(helper.inspect(&raw, cid)?)
    }

    fn check_removal(&self, engine: &LocalEngine, cid: &ContainerId) -> Result<()> {
        let socket = self.initial.target.target.engine_socket();
        let ids: Vec<String> = serde_json::from_slice(&engine.read(socket, Query::Inventory)?)?;
        if ids.iter().any(|id| id == cid.as_str()) {
            return Err("helper removal unconfirmed".into());
        }
        if self.initial.retained.iter().any(|id| !ids.contains(id)) {
            return Err("existing stopped container changed".into());
        }
        let paths = &self.initial.seat.paths;
        let stores = [paths.home().to_owned(), paths.nix().to_owned()];
        for batch in ids.chunks(32) {
            let ids = batch
                .iter()
                .map(|id| ContainerId::parse(id))
                .collect::<std::result::Result<Vec<_>, _>>()?;
            let rows = engine.read(socket, Query::Inspect(ids))?;
            observe::mount_custody::settled(&stores, &rows)?;
        }
        Ok(())
    }

    fn receipt(&self, cid: &ContainerId, profile_bytes: &[u8]) -> Result<Vec<u8>> {
        let target = &self.initial.target.target;
        let mut result = json!({
            "version": 1,
            "kind": "reverie.offline-store.receipt",
            "state": "STORE_PREPARED",
            "operationId": self.operation.as_str(),
            "employeeId": self.employee.as_str(),
            "sessionId": self.initial.seat.paths.session().as_str(),
            "imageId": target.image_id(),
            "helperContainerId": cid.as_str(),
            "planDigest": self.initial.plan.digest(),
            "offVacationPreserved": true,
            "providerLaunched": false,
            "containerAdoption": "NOT_RUN",
            "databaseObserverReads": false,
            "profileInventoryDigest": format!("sha256:{:x}", Sha256::digest(profile_bytes)),
        });
        if target.needs_isolated_image() {
            result["state"] = "STORE_PREPARED_RUNTIME_ACCEPTANCE_PENDING".into();
            result["validationScope"] = "VALIDATED_OFFLINE_IMAGE_TOOL_SHELL".into();
            result["runtimeAcceptance"] = "PENDING".into();
        }
        Ok(serde_json::to_vec(&result)?)
    }
}
