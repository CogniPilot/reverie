use super::*;
use crate::{
    captured_client::test_hooks::Hooks, engine_metadata::EngineBootstrap,
    installed_worker_engine::InstalledWorkerEngine,
};
use reverie_core::{
    resources::{BudgetMode, CpuQuota, ResourcePolicy},
    worker_schema::{WorkerBase, WorkerIds},
};
use std::{collections::BTreeMap, fs, os::unix::fs::PermissionsExt, path::PathBuf};

pub(super) struct Fixture {
    pub root: PathBuf,
    pub runtime: WorkerRuntime,
    pub hooks: Hooks,
    pub policy: WorkerPoolPolicy,
}
impl Fixture {
    pub fn new() -> Self {
        static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let program = crate::engine_metadata::tests::program();
        let root = std::env::temp_dir().join(format!(
            "pool-target-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let child = root.join("pool-target");
        fs::hard_link(program, &child).unwrap();
        let bootstrap =
            EngineBootstrap::from_service(child.as_os_str(), BTreeMap::new(), root.clone())
                .unwrap();
        let hooks = bootstrap.hooks.clone();
        let base = WorkerBase::try_new(
            "pool-fixture".into(),
            "pool-server".into(),
            image('a'),
            WorkerIds::try_new(1000, 100).unwrap(),
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
        let runtime = WorkerRuntime::new(InstalledWorkerEngine::new(bootstrap), &base);
        let policy = WorkerPoolPolicy::decode(&serde_json::to_vec(&serde_json::json!({
            "version":1,"purpose":"reverie-docker-worker-pool-v1","deployment":"pool-fixture",
            "instanceRoot":"/home/fixture/reverie","engineId":"11111111-1111-4111-8111-111111111111",
            "anchorImage":image('a'),"controllerImage":image('b'),"websiteContainer":"c".repeat(64),
            "brokerUid":1000,"brokerGid":100,"memoryMaxMiB":49152,"poolTasksMax":8192,
            "cpuWeight":100,"allowedCpus":[0,1],"employeeMemoryHighMiB":{"22222222-2222-4222-8222-222222222222":1536}
        })).unwrap()).unwrap();
        let fixture = Self {
            root,
            runtime,
            hooks,
            policy,
        };
        fixture.write("info", serde_json::json!({"ID":fixture.policy.engine_id,"OSType":"linux","CgroupDriver":"systemd","CgroupVersion":"2","SecurityOptions":[]}));
        fixture.write("anchor", image_data('a'));
        fixture.write("controller", image_data('b'));
        fixture
    }
    pub fn write(&self, name: &str, value: serde_json::Value) {
        fs::write(
            self.root.join(format!("{name}.json")),
            serde_json::to_vec(&value).unwrap(),
        )
        .unwrap();
    }
    pub fn starts(&self) -> usize {
        self.hooks.starts.load(Ordering::SeqCst)
    }
    pub fn finish(self) {
        self.runtime.close(end()).unwrap();
        fs::remove_dir_all(self.root).unwrap();
    }
}
pub(super) fn image(digit: char) -> String {
    format!("sha256:{}", digit.to_string().repeat(64))
}
pub(super) fn image_data(digit: char) -> serde_json::Value {
    serde_json::json!({"Id":image(digit),"Os":"linux","Config":{"Entrypoint":["overridden-at-create"],"User":"unrelated-default"}})
}
pub(super) fn end() -> Instant {
    Instant::now() + Duration::from_secs(3)
}
