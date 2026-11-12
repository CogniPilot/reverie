//! Fresh native absence/roster observations for a DATA-only nomination change.
use super::*;
use reverie_core::ids::{ContainerId, ProfileEmployeeId};
impl NominationDerivation {
    pub(in crate::worker_pool::installation_request::nomination) fn assert_retired_pending_policy(
        &self,
        digest: &reverie_core::operations::JournalDigest,
        request: &PoolInstallationRequestData,
    ) -> Result<()> {
        need(
            self.historical
                .contains_validated_policy(digest, request.principal())?,
            "POOL_PENDING_RETIRED_POLICY_REQUIRED",
        )
    }
    pub(in crate::worker_pool::installation_request::nomination) fn revised_highs(
        &self,
        original: &PoolInstallationRequestData,
        default: u32,
        overrides: &[(ProfileEmployeeId, u32)],
    ) -> Result<PoolInstallationRequestData> {
        self.assert_metadata_configured()?;
        Ok(original.with_employee_highs(
            self.company.as_ref().expect("same actual company"),
            default,
            overrides,
        )?)
    }
    fn assert_metadata_configured(&self) -> Result<()> {
        need(
            self.company.is_some() && self.company_stamp.is_some(),
            "POOL_NOMINATION_COMPANY_REQUIRED",
        )
    }
    pub(in crate::worker_pool::installation_request::nomination) fn assert_uninstalled(
        &mut self,
        runtime: &WorkerRuntime,
        policy: &WorkerPoolPolicy,
    ) -> Result<()> {
        self.assert_census(runtime, policy, None)?;
        self.prepared.observe(policy)?;
        for path in [
            PathBuf::from(&policy.instance_root).join("worker-pool/control"),
            PathBuf::from("/sys/fs/cgroup").join(policy.parent_cgroup_relative()),
        ] {
            match fs::symlink_metadata(path) {
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
                Err(e) => return Err(e.into()),
                Ok(_) => {
                    return Err(PoolNominationError::Refused(
                        "POOL_NOMINATION_INSTALLATION_RETAINED",
                    ));
                }
            }
        }
        Ok(())
    }
    pub(in crate::worker_pool::installation_request::nomination) fn assert_failed_installation_census(
        &mut self,
        runtime: &WorkerRuntime,
        policy: &WorkerPoolPolicy,
        retirement: &super::super::revision::retirement::Retirement,
    ) -> Result<()> {
        self.assert_census(runtime, policy, Some(retirement))?;
        match fs::symlink_metadata(
            PathBuf::from("/sys/fs/cgroup").join(policy.parent_cgroup_relative()),
        ) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.into()),
            Ok(_) => Err(PoolNominationError::Refused(
                "POOL_NOMINATION_INSTALLATION_RETAINED",
            )),
        }
    }
    pub(in crate::worker_pool::installation_request::nomination) fn assert_census(
        &mut self,
        runtime: &WorkerRuntime,
        policy: &WorkerPoolPolicy,
        retirement: Option<&super::super::revision::retirement::Retirement>,
    ) -> Result<()> {
        let raw = self.query(runtime, EngineQuery::InventoryIds)?;
        let mut ids = BTreeSet::new();
        for line in raw.lines() {
            let id = ContainerId::parse(line.trim())
                .map_err(|_| PoolNominationError::Refused("POOL_NOMINATION_CENSUS"))?;
            need(ids.insert(id), "POOL_NOMINATION_CENSUS")?;
        }
        need(
            !ids.is_empty() && ids.len() <= 256,
            "POOL_NOMINATION_CENSUS",
        )?;
        let pool = PathBuf::from(&policy.instance_root).join("worker-pool");
        let mut website = false;
        let mut failed_seen = false;
        for id in ids {
            let raw = self.query(runtime, EngineQuery::WorkerPoolInspect(&id))?;
            let values: Vec<serde_json::Value> = serde_json::from_str(&raw)
                .map_err(|_| PoolNominationError::Refused("POOL_NOMINATION_CENSUS"))?;
            need(
                values.len() == 1 && values[0]["Id"] == id.as_str(),
                "POOL_NOMINATION_CENSUS",
            )?;
            let row = &values[0];
            let name = row["Name"]
                .as_str()
                .ok_or(PoolNominationError::Refused("POOL_NOMINATION_CENSUS"))?;
            let empty = serde_json::Map::new();
            let labels = if row["Config"]["Labels"].is_null() {
                &empty
            } else {
                row["Config"]["Labels"]
                    .as_object()
                    .ok_or(PoolNominationError::Refused("POOL_NOMINATION_CENSUS"))?
            };
            need(
                labels.values().all(|v| v.is_string()),
                "POOL_NOMINATION_CENSUS",
            )?;
            if let Some(retirement) = retirement
                && retirement.matches_row(policy, &id, row)?
            {
                need(!failed_seen, "POOL_RETIRE_AMBIGUOUS_CONTROLLER")?;
                failed_seen = true;
                continue;
            }
            let end = self.deadline();
            if self.historical.matches_row(policy, &id, row, end)? {
                continue;
            }
            need(
                name != format!("/{}", policy.anchor_name())
                    && name != format!("/{}", policy.controller_name())
                    && labels
                        .get("reverie.pool.anchor")
                        .is_none_or(|v| v != &policy.deployment)
                    && labels
                        .get("reverie.resource-controller")
                        .is_none_or(|v| v != &policy.deployment),
                "POOL_NOMINATION_ALREADY_INSTALLED",
            )?;
            if labels
                .get("reverie.worker")
                .is_some_and(|v| v == &policy.deployment)
                || name.starts_with(&format!("/{}-agent-", policy.deployment))
            {
                need(
                    row["State"]["Running"] == false
                        && row["State"]["Pid"] == 0
                        && row["State"]["Paused"] == false
                        && row["State"]["Restarting"] == false,
                    "POOL_NOMINATION_WORKERS_MUST_BE_STOPPED",
                )?;
            }
            assert_no_pool_writer(row, &pool)?;
            website |= id.as_str() == policy.website_container;
        }
        need(website, "POOL_NOMINATION_WEBSITE_REQUIRED")?;
        need(
            retirement.is_none() || failed_seen,
            "POOL_RETIRE_CONTROLLER_DISAPPEARED",
        )?;
        Ok(())
    }
}
fn assert_no_pool_writer(row: &serde_json::Value, pool: &Path) -> Result<()> {
    let mounts = row["Mounts"]
        .as_array()
        .ok_or(PoolNominationError::Refused("POOL_NOMINATION_CENSUS"))?;
    for mount in mounts {
        let rw = mount["RW"]
            .as_bool()
            .ok_or(PoolNominationError::Refused("POOL_NOMINATION_CENSUS"))?;
        if !rw || mount["Type"] != "bind" {
            continue;
        }
        let source = mount["Source"]
            .as_str()
            .ok_or(PoolNominationError::Refused("POOL_NOMINATION_CENSUS"))?;
        let source = Path::new(source);
        need(
            !source.starts_with(pool) && !pool.starts_with(source),
            "POOL_NOMINATION_POOL_WRITER",
        )?;
    }
    Ok(())
}
