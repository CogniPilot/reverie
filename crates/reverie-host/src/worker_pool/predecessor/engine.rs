use super::*;
use crate::{
    captured_client::{CapturedCall, Policy},
    installed_worker_engine::InstalledWorkerEngine,
};
use reverie_contracts::{
    reservation_engine::{ContainerRow, InventoryDecoder, InventoryRows, inventory_ids},
    worker_pool::{validate_engine_information, validate_stopped_controller_service_v2_inspection},
};
use std::{fs, os::unix::fs::MetadataExt, path::PathBuf, sync::Arc, time::Duration};

pub(super) struct Engine {
    installed: Arc<InstalledWorkerEngine>,
    query: MetadataQueryOwner,
    stop: WorkerStopBudget,
    cancellation: CancellationToken,
    end: Instant,
}

impl Engine {
    pub(super) fn new(runtime: &WorkerRuntime, end: Instant) -> Self {
        Self {
            installed: runtime.installed_engine().clone(),
            query: runtime.readonly().capture_query_owner(),
            stop: runtime.stop_budget(),
            cancellation: runtime.cancellation(),
            end,
        }
    }

    pub(super) fn deadline(&self) -> Instant {
        self.stop
            .deadline()
            .map_or(self.end, |stop| stop.min(self.end))
    }

    pub(super) fn query(&self, query: EngineQuery<'_>) -> Result<String> {
        let end = self.deadline();
        need(Instant::now() < end, "WORKER_POOL_PREDECESSOR_DEADLINE")?;
        self.query
            .query(query, end, &self.cancellation)
            .map_err(PoolError::Engine)
    }

    pub(super) fn settle(&self) -> Result<()> {
        self.query
            .settle_owned(self.deadline())
            .map_err(PoolError::Engine)
    }

    pub(super) fn selected_id(&self, name: &str) -> Result<ContainerId> {
        name_owner(&self.inventory()?, name)?
            .map(|row| row.id().clone())
            .ok_or(PoolError::Refused("WORKER_POOL_PREDECESSOR_REQUIRED"))
    }

    pub(super) fn assert_name_absent(&self, name: &str) -> Result<()> {
        need(
            name_owner(&self.inventory()?, name)?.is_none(),
            "WORKER_POOL_STARTUP_CONTROLLER_NAME_OCCUPIED",
        )
    }

    pub(super) fn assert_name_pair(
        &self,
        id: &ContainerId,
        occupied: &str,
        vacant: &str,
    ) -> Result<()> {
        assert_name_pair(&self.inventory()?, id, occupied, vacant)
    }

    fn inventory(&self) -> Result<InventoryRows> {
        let invalid = |_| PoolError::Refused("WORKER_POOL_PREDECESSOR_CENSUS");
        let ids = inventory_ids(&self.query(EngineQuery::InventoryIds)?).map_err(invalid)?;
        let mut decoder = InventoryDecoder::new(&ids).map_err(invalid)?;
        for batch in ids.chunks(32) {
            decoder
                .push(&self.query(EngineQuery::InspectBatch(batch))?)
                .map_err(invalid)?;
        }
        decoder.finish().map_err(invalid)
    }

    pub(super) fn rename_controller(
        &self,
        id: &ContainerId,
        name: &str,
        retained: &mut Option<CapturedCall>,
    ) -> Result<()> {
        let command = ["rename", id.as_str(), name].map(Into::into).to_vec();
        let output = self.installed.engine.client.run_scoped(
            command,
            self.deadline(),
            &self.cancellation,
            Policy {
                maximum: Duration::from_secs(20),
                maximum_output: 65_536,
                successful_exit: true,
            },
        );
        match output {
            Ok(output) => need(
                output.stdout.is_empty() && output.stderr.is_empty(),
                "WORKER_POOL_RETIREMENT_RENAME_OUTPUT",
            ),
            Err(failure) => {
                *retained = failure.call;
                Err(PoolError::Engine(failure.error.into()))
            }
        }
    }

    pub(super) fn settle_rename(&self, call: &CapturedCall) -> Result<()> {
        self.installed
            .engine
            .client
            .settle_call(call, self.deadline())
            .map_err(|error| PoolError::Engine(error.into()))
    }
}

fn name_owner<'a>(rows: &'a InventoryRows, name: &str) -> Result<Option<&'a ContainerRow>> {
    let name = format!("/{name}");
    let mut matching = rows.rows().iter().filter(|row| row.name_is(&name));
    let selected = matching.next();
    need(
        matching.next().is_none(),
        "WORKER_POOL_PREDECESSOR_AMBIGUOUS",
    )?;
    Ok(selected)
}

fn assert_name_pair(
    rows: &InventoryRows,
    id: &ContainerId,
    occupied: &str,
    vacant: &str,
) -> Result<()> {
    let row = name_owner(rows, occupied)?.ok_or(PoolError::Refused(
        "WORKER_POOL_RETIREMENT_CONTROLLER_NAME_CHANGED",
    ))?;
    need(
        row.id() == id,
        "WORKER_POOL_RETIREMENT_CONTROLLER_NAME_CHANGED",
    )?;
    need(
        !row.running()
            .map_err(|_| PoolError::Refused("WORKER_POOL_RETIREMENT_INSPECTION"))?,
        "WORKER_POOL_RETIREMENT_CONTROLLER_RUNNING",
    )?;
    need(
        name_owner(rows, vacant)?.is_none(),
        "WORKER_POOL_RETIREMENT_NAME_OCCUPIED",
    )
}

pub(super) struct Controller {
    pub(super) id: ContainerId,
    pub(super) digest: JournalDigest,
    pub(super) raw: Vec<u8>,
    pub(super) exit_code: u8,
}

impl Controller {
    pub(super) fn observe(policy: &WorkerPoolPolicy, engine: &Engine) -> Result<Self> {
        let info = engine.query(EngineQuery::WorkerPoolInformation)?;
        validate_engine_information(info.as_bytes(), policy)
            .map_err(|_| PoolError::Refused("WORKER_POOL_PREDECESSOR_ENGINE"))?;
        let id = engine.selected_id(&policy.controller_name())?;
        let raw = engine
            .query(EngineQuery::WorkerPoolWebsiteInspect(&id))?
            .into_bytes();
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

    pub(super) fn assert_renamed(
        &self,
        engine: &Engine,
        original: &str,
        retired: &str,
    ) -> Result<()> {
        engine.assert_name_pair(&self.id, retired, original)?;
        let current = engine.query(EngineQuery::WorkerPoolWebsiteInspect(&self.id))?;
        self.assert_renamed_inspection(current.as_bytes(), original, retired)
    }

    fn assert_renamed_inspection(
        &self,
        current: &[u8],
        original: &str,
        retired: &str,
    ) -> Result<()> {
        let same = RecoveryInspection::same_renamed_container_object_inspection(
            self.id.as_str(),
            &self.raw,
            current,
            original,
            retired,
        )
        .map_err(|_| PoolError::Refused("WORKER_POOL_RETIREMENT_INSPECTION"))?;
        need(same, "WORKER_POOL_RETIREMENT_CONTROLLER_CHANGED")
    }
}

pub(super) fn assert_inactive(pid: u32, start: &str, id: &ContainerId) -> Result<()> {
    use nix::sys::statfs::{self, CGROUP2_SUPER_MAGIC, PROC_SUPER_MAGIC};

    let verify_filesystem = |path, expected| -> Result<()> {
        let fs = statfs::statfs(path).map_err(io::Error::from)?;
        need(
            fs.filesystem_type() == expected,
            "WORKER_POOL_PREDECESSOR_KERNEL_FILESYSTEM",
        )
    };
    verify_filesystem("/proc", PROC_SUPER_MAGIC)?;
    assert_original_broker_inactive(pid, start)?;
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

pub(super) fn assert_original_broker_inactive(pid: u32, original_start: &str) -> Result<()> {
    let path = PathBuf::from(format!("/proc/{pid}"));
    let first = observe_broker_process(&path, pid)?;
    need(
        first == observe_broker_process(&path, pid)?,
        "WORKER_POOL_PREDECESSOR_BROKER_UNSTABLE",
    )?;
    need(
        first.is_none_or(|(_, _, start)| start != original_start),
        "WORKER_POOL_PREDECESSOR_BROKER_PRESENT",
    )
}

fn observe_broker_process(path: &Path, pid: u32) -> Result<Option<(u64, u64, String)>> {
    let before = match fs::symlink_metadata(path) {
        Ok(before) => before,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let start = directory::process_start(pid)?;
    let after = fs::symlink_metadata(path)?;
    need(
        before.is_dir()
            && after.is_dir()
            && before.dev() == after.dev()
            && before.ino() == after.ino(),
        "WORKER_POOL_PREDECESSOR_BROKER_UNSTABLE",
    )?;
    Ok(Some((after.dev(), after.ino(), start)))
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
        let pid = std::process::id();
        let start = directory::process_start(pid).unwrap();
        let failure = assert_inactive(pid, &start, &id).unwrap_err();
        assert_eq!(failure.code(), "WORKER_POOL_PREDECESSOR_BROKER_PRESENT");
        let earlier_start = (start.parse::<u64>().unwrap() - 1).to_string();
        assert_original_broker_inactive(pid, &earlier_start).unwrap();
    }

    #[test]
    fn retirement_readback_accepts_only_the_original_stopped_container_at_the_new_name() {
        let id = ContainerId::parse(&"e".repeat(64)).unwrap();
        let original = serde_json::json!({
            "Id": id.as_str(),
            "Name": "/original",
            "Mounts": [],
            "State": {"Running": false, "ExitCode": 137}
        });
        let controller = Controller {
            id,
            digest: JournalDigest::parse(&"a".repeat(64)).unwrap(),
            raw: serde_json::to_vec(&original).unwrap(),
            exit_code: 137,
        };
        let inspect = |current: &serde_json::Value| {
            controller.assert_renamed_inspection(
                &serde_json::to_vec(current).unwrap(),
                "original",
                "retired",
            )
        };
        assert!(inspect(&original).is_err());
        let mut retired = original;
        retired["Name"] = "/retired".into();
        inspect(&retired).unwrap();
        let mut foreign = retired.clone();
        foreign["Id"] = "f".repeat(64).into();
        assert!(inspect(&foreign).is_err());
        let mut restarted = retired.clone();
        restarted["State"]["Running"] = true.into();
        assert!(inspect(&restarted).is_err());
        retired["State"]["ExitCode"] = 0.into();
        assert_eq!(
            inspect(&retired).unwrap_err().code(),
            "WORKER_POOL_RETIREMENT_CONTROLLER_CHANGED"
        );
    }

    #[test]
    fn retirement_name_pair_requires_the_exact_stopped_owner_and_no_collision() {
        let id = ContainerId::parse(&"e".repeat(64)).unwrap();
        let foreign = ContainerId::parse(&"f".repeat(64)).unwrap();
        let row = |id: &ContainerId, name: &str, running: bool| {
            serde_json::json!({
                "Id": id.as_str(), "Name": name, "Mounts": [], "State": {"Running": running}
            })
        };
        let verify = |original: &str, running: bool, second: &str| {
            let rows = InventoryRows::decode(
                &[id.clone(), foreign.clone()],
                &[format!(
                    "{}\n{}\n",
                    row(&id, original, running),
                    row(&foreign, second, true)
                )],
            )
            .unwrap();
            assert_name_pair(&rows, &id, "original", "retired")
        };
        verify("/original", false, "/foreign").unwrap();
        for (original, running, second, reason) in [
            (
                "/original",
                false,
                "/retired",
                "WORKER_POOL_RETIREMENT_NAME_OCCUPIED",
            ),
            (
                "/original",
                true,
                "/foreign",
                "WORKER_POOL_RETIREMENT_CONTROLLER_RUNNING",
            ),
            (
                "/foreign",
                false,
                "/original",
                "WORKER_POOL_RETIREMENT_CONTROLLER_NAME_CHANGED",
            ),
        ] {
            assert_eq!(
                verify(original, running, second).unwrap_err().code(),
                reason
            );
        }
    }
}
