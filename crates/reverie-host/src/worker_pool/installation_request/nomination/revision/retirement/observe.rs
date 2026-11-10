use super::*;
use reverie_contracts::{
    worker_pool::{validate_failed_controller_service_v2_inspection, WorkerPoolPolicy},
    worker_recovery::RecoveryInspection,
};
impl Retirement {
    pub(in crate::worker_pool::installation_request::nomination::revision) fn prepare(
        &mut self,
        owner: &mut NominationOwner,
    ) -> Result<PoolInstallationRequestData> {
        self.capture_controller(owner)?;
        let policy = owner.request.as_ref().expect("original request").policy();
        self.namespace
            .capture(policy, self.birth.as_ref().expect("actual birth label"))?;
        let birth = self.namespace.birth()?;
        self.immutable
            .observe_broker_program(birth.program(), owner.end)?;
        match fs::symlink_metadata(format!("/proc/{}", birth.broker().pid())) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(e) => return Err(e.into()),
            Ok(_) => {
                return Err(PoolNominationError::Refused(
                    "POOL_RETIRE_ORIGINAL_BROKER_PRESENT",
                ));
            }
        }
        let id = self.id.as_ref().expect("derived CID").as_str().to_owned();
        self.logs = Some(self.call(
            owner,
            ["logs", "--timestamps=false", &id].map(Into::into).to_vec(),
        )?);
        let logs = self.logs.as_ref().expect("actual retained logs");
        need(
            logs.stdout.is_empty()
                && matches!(
                    logs.stderr.as_slice(),
                    b"WORKER_POOL_ENGINE_ROOT_PEER_REQUIRED\nWORKER_POOL_CLOSE_UNKNOWN\n"
                        | b"WORKER_POOL_WEBSITE_CHANGED\n"
                ),
            "POOL_RETIRE_FAILED_PREFIX_REQUIRED",
        )?;
        let reference = compiled_pool_image_inputs_reference()?.ok_or(
            PoolNominationError::Refused("POOL_RETIRE_FIXED_IMAGES_REQUIRED"),
        )?;
        self.inputs_raw = Some(self.immutable.observe_artifact(
            &reference,
            ImmutableInputKind::PoolImageInputs,
            owner.end,
        )?);
        self.inputs = Some(PoolImageInputsData::decode(
            self.inputs_raw
                .as_ref()
                .expect("retained fixed inputs")
                .bytes(),
        )?);
        let images = owner
            .derived
            .as_mut()
            .expect("same actual derivation")
            .find_images(
                &owner.runtime,
                self.inputs.as_ref().expect("fixed new images"),
            )?;
        let next = owner
            .request
            .as_ref()
            .expect("original request")
            .with_fixed_images(images)?;
        self.assert_current(owner)?;
        Ok(next)
    }
    fn capture_controller(&mut self, owner: &mut NominationOwner) -> Result<()> {
        need(self.id.is_none(), "POOL_RETIRE_ALREADY_CAPTURED")?;
        let policy = owner.request.as_ref().expect("old proposal").policy();
        let raw = owner.derived.as_mut().expect("same derivation").query(
            &owner.runtime,
            crate::engine_metadata::EngineQuery::InventoryIds,
        )?;
        let mut ids = std::collections::BTreeSet::new();
        for line in raw.lines() {
            let id = ContainerId::parse(line.trim())
                .map_err(|_| PoolNominationError::Refused("POOL_RETIRE_CENSUS"))?;
            need(ids.insert(id) && ids.len() <= 256, "POOL_RETIRE_CENSUS")?;
        }
        for id in ids {
            let raw = owner.derived.as_mut().expect("same reader").query(
                &owner.runtime,
                crate::engine_metadata::EngineQuery::WorkerPoolWebsiteInspect(&id),
            )?;
            let row: serde_json::Value = serde_json::from_str(&raw)
                .map_err(|_| PoolNominationError::Refused("POOL_RETIRE_INSPECTION"))?;
            need(row["Id"] == id.as_str(), "POOL_RETIRE_INSPECTION")?;
            if row["Name"] != format!("/{}", policy.controller_name()) {
                continue;
            }
            need(self.id.is_none(), "POOL_RETIRE_AMBIGUOUS_CONTROLLER")?;
            self.id = Some(id);
            let birth = row["Config"]["Labels"]["reverie.pool.birth-policy"]
                .as_str()
                .and_then(|v| JournalDigest::parse(v).ok())
                .ok_or(PoolNominationError::Refused("POOL_RETIRE_BIRTH"))?;
            self.birth = Some(birth.as_str().to_owned());
            self.original = Some(raw.into_bytes());
        }
        need(self.id.is_some(), "POOL_RETIRE_CONTROLLER_REQUIRED")?;
        self.validate_raw(
            policy,
            self.original.as_ref().expect("actual inspection"),
            &policy.controller_name(),
        )
    }
    fn validate_raw(&self, policy: &WorkerPoolPolicy, raw: &[u8], name: &str) -> Result<()> {
        validate_failed_controller_service_v2_inspection(
            raw,
            policy,
            self.id
                .as_ref()
                .ok_or(PoolNominationError::Refused(
                    "POOL_RETIRE_CONTROLLER_REQUIRED",
                ))?
                .as_str(),
            self.birth
                .as_ref()
                .ok_or(PoolNominationError::Refused("POOL_RETIRE_BIRTH"))?,
            name,
        )
        .map_err(|_| PoolNominationError::Refused("POOL_RETIRE_FAILED_CONTROLLER_CHANGED"))
    }
    pub(in crate::worker_pool::installation_request::nomination) fn matches_row(
        &self,
        policy: &WorkerPoolPolicy,
        id: &ContainerId,
        row: &serde_json::Value,
    ) -> Result<bool> {
        if self.id.as_ref() != Some(id) {
            return Ok(false);
        }
        let old_name = policy.controller_name();
        let name = if self.retired {
            self.retired_name.as_ref().expect("known rename")
        } else {
            &old_name
        };
        self.validate_raw(
            policy,
            &serde_json::to_vec(row)
                .map_err(|_| PoolNominationError::Refused("POOL_RETIRE_INSPECTION"))?,
            name,
        )?;
        Ok(true)
    }
    pub(in crate::worker_pool::installation_request::nomination::revision) fn assert_current(
        &mut self,
        owner: &mut NominationOwner,
    ) -> Result<()> {
        self.assert_metadata()?;
        let policy = owner.request.as_ref().expect("original request").policy();
        let id = self.id.as_ref().ok_or(PoolNominationError::Refused(
            "POOL_RETIRE_CONTROLLER_REQUIRED",
        ))?;
        let raw = owner.derived.as_mut().expect("same actual reader").query(
            &owner.runtime,
            crate::engine_metadata::EngineQuery::WorkerPoolWebsiteInspect(id),
        )?;
        let old = policy.controller_name();
        let name = if self.retired {
            self.retired_name.as_ref().expect("known retirement")
        } else {
            &old
        };
        self.validate_raw(policy, raw.as_bytes(), name)?;
        need(
            RecoveryInspection::same_renamed_container_object_inspection(
                id.as_str(),
                self.original.as_ref().expect("original whole inspection"),
                raw.as_bytes(),
                &old,
                name,
            )
            .map_err(|_| PoolNominationError::Refused("POOL_RETIRE_INSPECTION"))?,
            "POOL_RETIRE_INSPECTION_CHANGED",
        )?;
        owner
            .derived
            .as_mut()
            .expect("same census")
            .assert_failed_installation_census(&owner.runtime, policy, self)?;
        for path in [PathBuf::from("/sys/fs/cgroup/system.slice")
            .join(format!("docker-{}.scope", id.as_str()))]
        {
            match fs::symlink_metadata(path) {
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
                Err(e) => return Err(e.into()),
                Ok(_) => {
                    return Err(PoolNominationError::Refused(
                        "POOL_RETIRE_CONTROLLER_TASKS_RETAINED",
                    ));
                }
            }
        }
        self.assert_metadata()
    }
}
