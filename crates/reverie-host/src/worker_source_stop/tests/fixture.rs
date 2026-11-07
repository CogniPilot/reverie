use super::*;
use crate::{engine_metadata::EngineBootstrap, installed_worker_engine::InstalledWorkerEngine};
use reverie_contracts::{
    kernel_accounting,
    reservation_baseline::{OriginalBaselineFields, OriginalRuntimeTail, OriginalSourceBaseline},
    reservation_engine::{InventoryRows, NativeLimitBinding, NativeStorageBinding},
    worker_config,
    worker_schema::WorkerEnvelope,
};
use reverie_core::{
    decimal::UnsignedInteger,
    ids::{ContainerId, ProfileSessionId},
    posix_path::PosixPath,
};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs,
    os::unix::fs::{MetadataExt, PermissionsExt},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        OnceLock,
        atomic::{AtomicUsize, Ordering},
    },
    thread::JoinHandle,
    time::Duration,
};

static PROGRAM: OnceLock<PathBuf> = OnceLock::new();
static NEXT: AtomicUsize = AtomicUsize::new(0);
pub(super) const SID: &str = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
pub(super) const OTHER: &str = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
const EID: &str = "11111111-2222-4333-8444-555555555555";
pub(super) fn end() -> Instant {
    Instant::now() + Duration::from_secs(5)
}
fn program() -> &'static Path {
    PROGRAM.get_or_init(|| {
        let root = std::env::temp_dir().join(format!("source-stop-build-{}", std::process::id()));
        fs::create_dir(&root).unwrap();
        let source = root.join("child.rs");
        fs::write(
            &source,
            include_str!("../../../tests/support/source_stop_child.rs"),
        )
        .unwrap();
        let binary = root.join("child");
        assert!(
            Command::new("rustc")
                .arg("--edition=2024")
                .arg(&source)
                .arg("-o")
                .arg(&binary)
                .status()
                .unwrap()
                .success()
        );
        binary
    })
}
pub(super) struct Fixture {
    pub(super) root: PathBuf,
    pub(super) runtime: Arc<WorkerRuntime>,
    pub(super) config: EffectiveWorkerConfig,
    pub(super) row: Value,
    pub(super) start: String,
    target: Option<JoinHandle<()>>,
}
impl Fixture {
    pub(super) fn release_target(&mut self) {
        fs::write(self.root.join("release-source"), b"owned known exit").unwrap();
        if let Some(target) = self.target.take() {
            target.join().unwrap();
        }
    }
    pub(super) fn new(exit_on: &str) -> Self {
        let program = program();
        let root = fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(format!(
                "ss-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        fs::write(root.join("company.json"),serde_json::to_vec(&json!({"employees":[{"id":EID,"sessionId":SID,"owner":null,"desiredRunning":true}]})).unwrap()).unwrap();
        fs::set_permissions(root.join("company.json"), fs::Permissions::from_mode(0o600)).unwrap();
        fs::create_dir(root.join("workspace")).unwrap();
        let info = fs::metadata(&root).unwrap();
        let config = worker_config::decode(&serde_json::to_vec(&json!({"version":1,"deployment":"test","serverContainer":"test-server","image":format!("sha256:{}","a".repeat(64)),"socket":"/run/source-stop.sock","uid":info.uid(),"gid":info.gid(),"stateRoot":root.join("state"),"scratchRoot":root.join("scratch"),"companyFile":root.join("company.json"),"companyRoot":root.join("company"),"apiSocketRoot":root.join("office"),"budgetMode":"pool","memoryMiB":0,"poolMemoryMiB":4096,"poolTasksMax":1024,"cgroupParent":"reverie-workers.slice","pidsLimit":128,"cpus":0,"maxWorkers":4,"mounts":[{"source":root.join("workspace"),"destination":"/workspace","readOnly":false}],"maintenanceSessions":[]})).unwrap()).unwrap();
        let base = WorkerEnvelope::capture(config.clone()).unwrap();
        let bootstrap = EngineBootstrap::from_service(
            program.as_os_str(),
            BTreeMap::from([("SOURCE_EXIT_ON".into(), exit_on.into())]),
            root.clone(),
        )
        .unwrap();
        let runtime = Arc::new(WorkerRuntime::new(
            InstalledWorkerEngine::new(bootstrap),
            base.base(),
        ));
        // Start the controlled target BEFORE acquiring any resource lease.
        let mut child = Command::new(program)
            .arg("target")
            .env("SOURCE_EXIT_ON", exit_on)
            .current_dir(&root)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let pid = child.id();
        let until = end();
        while !root.join("source-ready").exists() {
            assert!(Instant::now() < until);
            std::thread::sleep(Duration::from_millis(1));
        }
        let start = kernel_accounting::process_start(
            &fs::read_to_string(format!("/proc/{pid}/stat")).unwrap(),
        )
        .unwrap();
        let mut row: Value = serde_json::from_str(
            serde_json::from_str::<Value>(include_str!(
                "../../../../reverie-contracts/tests/fixtures/source-stop-python.json"
            ))
            .unwrap()["cases"][0]["before"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
        let row = &mut row[0];
        row["Name"] = json!(format!("/test-agent-{SID}"));
        row["State"]["Pid"] = json!(pid);
        row["Config"]["Labels"]["reverie.session"] = json!(SID);
        row["Config"]["Labels"]["reverie.worker-policy"] =
            json!(worker_config::policy_digest(&config).to_hex());
        row["HostConfig"]["Memory"] = json!(512 * 1_048_576);
        row["HostConfig"]["MemorySwap"] = json!(512 * 1_048_576);
        row["HostConfig"]["PidsLimit"] = json!(128);
        row["HostConfig"]["NanoCpus"] = json!(0);
        let row = row.clone();
        fs::write(root.join("cid"), row["Id"].as_str().unwrap()).unwrap();
        fs::write(root.join("name"), format!("test-agent-{SID}")).unwrap();
        let target_root = root.clone();
        let target = std::thread::spawn(move || {
            assert!(child.wait().unwrap().success());
            fs::write(target_root.join("source-reaped"), b"reaped").unwrap();
        });
        let fixture = Self {
            root,
            runtime,
            config,
            row,
            start,
            target: Some(target),
        };
        fixture.write_rows("before.json", &fixture.row);
        fixture.write_stopped("after.json");
        fixture.write_stopped("final.json");
        fixture
    }
    pub(super) fn write_rows(&self, name: &str, row: &Value) {
        fs::write(
            self.root.join(name),
            serde_json::to_vec(&json!([row])).unwrap(),
        )
        .unwrap();
    }
    pub(super) fn write_stopped(&self, name: &str) {
        let mut row = self.row.clone();
        row["State"] = json!({"Running":false,"Pid":0});
        self.write_rows(name, &row);
    }
    pub(super) fn name(&self, session: &str, start: &str) -> SourceStopName {
        let mut row = self.row.clone();
        row["Name"] = json!(format!("/test-agent-{session}"));
        let id = ContainerId::parse(row["Id"].as_str().unwrap()).unwrap();
        let inventory = InventoryRows::decode(&[id], &[row.to_string()]).unwrap();
        let row = &inventory.rows()[0];
        let zero = UnsignedInteger::from_u64(0);
        let native = NativeLimitBinding::from_observed_data(
            row,
            &row.declarations(&zero).unwrap(),
            start,
            &PosixPath::from_scalar_text("owned-source"),
            None,
        )
        .unwrap();
        let baseline = OriginalSourceBaseline::from_observed_data(OriginalBaselineFields {
            source: row,
            native: &native,
            storage: &NativeStorageBinding::from_observed_data([[1, 1, 1000, 100]; 3]),
            site: &native,
            commitments: &[],
            total: &zero,
            budget: &zero,
            runtime: &OriginalRuntimeTail::from_observed_data([1, 1], vec![]),
        });
        SourceStopName::from_baseline(
            WorkerEnvelope::capture(self.config.clone()).unwrap().base(),
            &baseline,
        )
        .unwrap()
    }
    pub(super) fn storage(&self) -> Box<LaunchStorage> {
        Box::new(
            self.runtime
                .resolve_storage(&self.config, &ProfileSessionId::parse(SID).unwrap())
                .unwrap()
                .acquire()
                .unwrap_or_else(|_| panic!("real owned source lease")),
        )
    }
    pub(super) fn owner(&self) -> OriginalSourceStop {
        self.runtime
            .retain_original_source_stop(
                self.storage(),
                self.name(SID, &self.start),
                &self.config,
                Some(end()),
            )
            .unwrap_or_else(|_| panic!("same source resources"))
    }
    pub(super) fn trace(&self) -> Vec<String> {
        fs::read_to_string(self.root.join("trace"))
            .unwrap_or_default()
            .lines()
            .map(str::to_owned)
            .collect()
    }
    pub(super) fn assert_held(&self) {
        assert!(
            crate::worker_storage::StorageLease::acquire_launch(
                &self.config,
                &ProfileSessionId::parse(SID).unwrap()
            )
            .is_err()
        );
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::write(self.root.join("release-source"), b"fixture teardown").unwrap();
        if let Some(target) = self.target.take() {
            target.join().unwrap();
        }
        self.runtime.close(end()).unwrap();
        fs::remove_dir_all(&self.root).unwrap();
    }
}
