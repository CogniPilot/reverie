use super::*;
use reverie_contracts::{
    reservation_engine::{InventoryDecoder, inventory_ids},
    worker_pool::{validate_engine_information, validate_stopped_controller_service_v2_inspection},
};
use std::{fs, path::PathBuf};

pub(super) struct Controller {
    pub(super) id: ContainerId,
    pub(super) digest: JournalDigest,
    pub(super) raw: Vec<u8>,
    pub(super) exit_code: u8,
}

impl Controller {
    pub(super) fn observe(
        policy: &WorkerPoolPolicy,
        query: impl Fn(EngineQuery<'_>) -> Result<String>,
    ) -> Result<Self> {
        let info = query(EngineQuery::WorkerPoolInformation)?;
        validate_engine_information(info.as_bytes(), policy)
            .map_err(|_| PoolError::Refused("WORKER_POOL_PREDECESSOR_ENGINE"))?;
        let id = selected_id(policy, &query)?;
        let raw = query(EngineQuery::WorkerPoolWebsiteInspect(&id))?.into_bytes();
        let parsed: serde_json::Value = serde_json::from_slice(&raw)
            .map_err(|_| PoolError::Refused("WORKER_POOL_PREDECESSOR_INSPECTION"))?;
        let digest = parsed["Config"]["Labels"]["reverie.pool.birth-policy"]
            .as_str()
            .and_then(|label| JournalDigest::parse(label).ok())
            .ok_or(PoolError::Refused("WORKER_POOL_PREDECESSOR_BIRTH"))?;
        let exit_code = validate_stopped_controller_service_v2_inspection(
            &raw,
            policy,
            id.as_str(),
            digest.as_str(),
        )
        .map_err(|_| PoolError::Refused("WORKER_POOL_PREDECESSOR_STOPPED_SPEC"))?;
        Ok(Self {
            id,
            digest,
            raw,
            exit_code,
        })
    }
}

fn selected_id(
    policy: &WorkerPoolPolicy,
    query: &impl Fn(EngineQuery<'_>) -> Result<String>,
) -> Result<ContainerId> {
    let invalid = |_| PoolError::Refused("WORKER_POOL_PREDECESSOR_CENSUS");
    let ids = inventory_ids(&query(EngineQuery::InventoryIds)?).map_err(invalid)?;
    let mut decoder = InventoryDecoder::new(&ids).map_err(invalid)?;
    for batch in ids.chunks(32) {
        decoder
            .push(&query(EngineQuery::InspectBatch(batch))?)
            .map_err(invalid)?;
    }
    let inventory = decoder.finish().map_err(invalid)?;
    let name = format!("/{}", policy.controller_name());
    let mut rows = inventory.rows().iter().filter(|row| row.name_is(&name));
    let row = rows
        .next()
        .ok_or(PoolError::Refused("WORKER_POOL_PREDECESSOR_REQUIRED"))?;
    need(rows.next().is_none(), "WORKER_POOL_PREDECESSOR_AMBIGUOUS")?;
    Ok(row.id().clone())
}

pub(super) fn assert_inactive(pid: u32, id: &ContainerId) -> Result<()> {
    use nix::sys::statfs::{self, CGROUP2_SUPER_MAGIC, PROC_SUPER_MAGIC};

    let verify_filesystem = |path, expected| -> Result<()> {
        let fs = statfs::statfs(path).map_err(io::Error::from)?;
        need(
            fs.filesystem_type() == expected,
            "WORKER_POOL_PREDECESSOR_KERNEL_FILESYSTEM",
        )
    };
    verify_filesystem("/proc", PROC_SUPER_MAGIC)?;
    absent(
        &PathBuf::from(format!("/proc/{pid}")),
        "WORKER_POOL_PREDECESSOR_BROKER_PRESENT",
    )?;
    let system = Path::new("/sys/fs/cgroup/system.slice");
    verify_filesystem("/sys/fs/cgroup/system.slice", CGROUP2_SUPER_MAGIC)?;
    need(
        fs::symlink_metadata(system)?.is_dir(),
        "WORKER_POOL_PREDECESSOR_SYSTEM_SLICE",
    )?;
    absent(
        &system.join(format!("docker-{}.scope", id.as_str())),
        "WORKER_POOL_PREDECESSOR_CONTROLLER_SCOPE_PRESENT",
    )
}

fn absent(path: &Path, code: &'static str) -> Result<()> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
        Ok(_) => Err(PoolError::Refused(code)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn actual_live_process_precludes_predecessor_observation() {
        let id = ContainerId::parse(&"e".repeat(64)).unwrap();
        let failure = assert_inactive(std::process::id(), &id).unwrap_err();
        assert_eq!(failure.code(), "WORKER_POOL_PREDECESSOR_BROKER_PRESENT");
    }
}
