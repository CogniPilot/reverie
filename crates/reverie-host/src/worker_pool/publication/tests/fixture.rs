use super::*;
use crate::{engine_metadata::EngineBootstrap, installed_worker_engine::InstalledWorkerEngine};
use reverie_contracts::worker_pool::{BrokerBirthData, BrokerProgramData};
use reverie_core::{
    resources::{BudgetMode, CpuQuota, ResourcePolicy},
    worker_schema::{WorkerBase, WorkerIds},
};
use std::{collections::BTreeMap, os::unix::fs::DirBuilderExt, path::PathBuf};

pub(super) fn isolated(name: &str) -> bool {
    crate::test_process::isolate_case(&format!("worker_pool::publication::tests::{name}"))
}
pub(super) struct Fixture {
    directory: PathBuf,
    pub(super) root: PathBuf,
    pub(super) runtime: WorkerRuntime,
    pub(super) starts: std::sync::Arc<std::sync::atomic::AtomicUsize>,
}
impl Fixture {
    pub(super) fn new() -> Self {
        let mut nonce = [0; 16];
        getrandom::getrandom(&mut nonce).unwrap();
        let directory =
            std::env::temp_dir().join(format!("pool-birth-{:032x}", u128::from_ne_bytes(nonce)));
        fs::DirBuilder::new()
            .mode(0o700)
            .create(&directory)
            .unwrap();
        let root = directory.join("reverie");
        fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
        let (runtime, starts) = runtime();
        Self {
            directory,
            root,
            runtime,
            starts,
        }
    }
    pub(super) fn versions(&self) -> PathBuf {
        self.root.join("worker-pool/policies")
    }
    pub(super) fn create_versions(&self) {
        fs::DirBuilder::new()
            .mode(0o700)
            .create(self.root.join("worker-pool"))
            .unwrap();
        fs::DirBuilder::new()
            .mode(0o700)
            .create(self.versions())
            .unwrap();
        fs::set_permissions(self.versions(), fs::Permissions::from_mode(0o750)).unwrap();
    }
    pub(super) fn owner(&self) -> ControllerBirthPublication {
        // Lower metadata fixture only. Production unopened() additionally
        // requires the actual NSS home/reverie; bootstrap is separately pinned.
        ControllerBirthPublication::new(
            &self.runtime,
            self.birth(),
            self.root.clone(),
            Instant::now() + Duration::from_secs(10),
        )
        .unwrap()
    }
    pub(super) fn birth(&self) -> ControllerBirthV2 {
        let ids = [native::uid(), nix::unistd::getegid().as_raw()];
        let policy = WorkerPoolPolicy::decode(&serde_json::to_vec(&serde_json::json!({
            "version":1,"purpose":"reverie-docker-worker-pool-v1","deployment":"publication-fixture",
            "instanceRoot":self.root,"engineId":"11111111-1111-4111-8111-111111111111",
            "anchorImage":format!("sha256:{}","a".repeat(64)),"controllerImage":format!("sha256:{}","b".repeat(64)),
            "websiteContainer":"c".repeat(64),"brokerUid":ids[0],"brokerGid":ids[1],"memoryMaxMiB":49152,
            "poolTasksMax":8192,"cpuWeight":100,"allowedCpus":[0,1],
            "employeeMemoryHighMiB":{"22222222-2222-4222-8222-222222222222":512}
        })).unwrap()).unwrap();
        let broker = BrokerBirthData::from_observations(
            std::process::id(),
            "1".into(),
            ids,
            [1, 2],
            [1, 2, 3],
            "a".repeat(64),
        )
        .unwrap();
        let program = BrokerProgramData::decode(
            &serde_json::to_vec(&serde_json::json!({
                "version":1,"purpose":"reverie-native-worker-broker-v1",
                "executable":"/nix/store/metadata-data-fixture/bin/reverie-worker-broker",
                "executableSHA256":"a".repeat(64),"bytes":1
            }))
            .unwrap(),
        )
        .unwrap();
        ControllerBirthV2::from_observations(policy, broker, program).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.runtime
            .close(Instant::now() + Duration::from_secs(5))
            .unwrap();
        fs::remove_dir_all(&self.directory).unwrap();
    }
}
fn runtime() -> (
    WorkerRuntime,
    std::sync::Arc<std::sync::atomic::AtomicUsize>,
) {
    // Inert existing engine capture. No query or program executes in this
    // component fixture; it supplies actual cancellation/first-stop identity.
    let capture = EngineBootstrap::from_service(
        std::env::current_exe().unwrap().as_os_str(),
        BTreeMap::new(),
        fs::canonicalize(std::env::temp_dir()).unwrap(),
    )
    .unwrap();
    let base = WorkerBase::try_new(
        "publication-fixture".into(),
        "fixture-server".into(),
        format!("sha256:{}", "a".repeat(64)),
        WorkerIds::try_new(native::uid(), nix::unistd::getegid().as_raw()).unwrap(),
        4,
        ResourcePolicy::try_new(
            BudgetMode::Admission,
            1024,
            128,
            CpuQuota::from_integer(1).unwrap(),
            8192,
            512,
        )
        .unwrap(),
    )
    .unwrap();
    let starts = capture.hooks.starts.clone();
    (
        WorkerRuntime::new(InstalledWorkerEngine::new(capture), &base),
        starts,
    )
}
