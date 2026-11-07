mod cleanup;
mod create;
mod publication;
mod reference;
use super::*;
use crate::{
    engine_metadata::EngineBootstrap,
    installed_worker_engine::InstalledWorkerEngine,
    office::OfficeService,
    worker_nix::{NixProgress, NixStoreGuard},
};
use reverie_contracts::{
    worker_config::{self, EffectiveWorkerConfig},
    worker_schema::WorkerEnvelope,
};
use reverie_core::ids::ProfileSessionId;
use serde_json::json;
use std::{
    collections::BTreeMap,
    fs,
    net::{IpAddr, Ipv4Addr},
    os::unix::fs::{MetadataExt, PermissionsExt},
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};
static PROGRAM: OnceLock<PathBuf> = OnceLock::new();
static NEXT: AtomicU64 = AtomicU64::new(0);
const SID: &str = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
fn program() -> &'static Path {
    PROGRAM.get_or_init(|| {
        let root = std::env::temp_dir().join(format!("laptop-child-build-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let source = root.join("child.rs");
        fs::write(
            &source,
            include_str!("../../tests/support/worker_laptop_child.rs"),
        )
        .unwrap();
        let binary = root.join("child");
        assert!(
            Command::new("rustc")
                .args(["--edition=2024", "-o"])
                .arg(&binary)
                .arg(source)
                .status()
                .unwrap()
                .success()
        );
        binary
    })
}
fn sid() -> ProfileSessionId {
    ProfileSessionId::parse(SID).unwrap()
}
fn end() -> Instant {
    Instant::now() + Duration::from_secs(3)
}
struct Fixture {
    root: PathBuf,
    runtime: Option<Arc<WorkerRuntime>>,
    office: OfficeService,
    source: EffectiveWorkerConfig,
}
impl Fixture {
    fn new(mode: &str) -> Self {
        let _ = program();
        let root = fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(format!(
                "lp-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        fs::write(root.join("company.json"), b"{\"employees\":[]}").unwrap();
        fs::set_permissions(root.join("company.json"), fs::Permissions::from_mode(0o600)).unwrap();
        fs::create_dir(root.join("work")).unwrap();
        let info = fs::metadata(&root).unwrap();
        let source=worker_config::decode(&serde_json::to_vec(&json!({"version":1,"deployment":"fixture","image":format!("sha256:{}","a".repeat(64)),"serverContainer":"fixture-server","socket":"/run/launch-order.sock","stateRoot":root.join("state"),"companyFile":root.join("company.json"),"companyRoot":root.join("company"),"scratchRoot":root.join("scratch"),"apiSocketRoot":root.join("api"),"budgetMode":"pool","uid":info.uid(),"gid":info.gid(),"memoryMiB":0,"poolMemoryMiB":4096,"poolTasksMax":1024,"cgroupParent":"reverie-workers.slice","pidsLimit":128,"cpus":0,"maxWorkers":4,"mounts":[{"source":root.join("work"),"destination":"/workspace","readOnly":false}],"maintenanceSessions":[]})).unwrap()).unwrap();
        let envelope = WorkerEnvelope::capture(source.clone()).unwrap();
        let bootstrap = EngineBootstrap::from_service(
            program().as_os_str(),
            BTreeMap::from([("LAPTOP_FIXTURE_MODE".into(), mode.into())]),
            root.clone(),
        )
        .unwrap();
        let runtime = Arc::new(WorkerRuntime::new(
            InstalledWorkerEngine::new(bootstrap),
            envelope.base(),
        ));
        let office =
            OfficeService::from_runtime(&runtime, root.clone(), IpAddr::V4(Ipv4Addr::LOCALHOST))
                .unwrap();
        Self {
            root,
            runtime: Some(runtime),
            office,
            source,
        }
    }
    fn runtime(&self) -> &Arc<WorkerRuntime> {
        self.runtime.as_ref().unwrap()
    }
    fn resources(&self) -> (NixWorkflow, ObservedCreatePlan, WorkerRequest, OfficePhone) {
        self.resources_for(&sid())
    }
    fn resources_for(
        &self,
        session: &ProfileSessionId,
    ) -> (NixWorkflow, ObservedCreatePlan, WorkerRequest, OfficePhone) {
        let mut storage = self
            .runtime()
            .resolve_storage(&self.source, session)
            .unwrap()
            .into_legacy()
            .unwrap();
        storage.prepare_storage().unwrap();
        let plan = self
            .runtime()
            .prepare_laptop_plan(self.source.clone(), self.source.clone(), &storage)
            .unwrap();
        let guard = NixStoreGuard::acquire_launch(&self.source, session).unwrap();
        let nix = self
            .runtime()
            .retain_nix_store(guard, storage, self.source.clone())
            .unwrap_or_else(|_| panic!("actual Nix retain"));
        assert_eq!(
            self.runtime().run_nix_store(&nix).unwrap(),
            NixProgress::NoHelper
        );
        let request=WorkerRequest::decode(&serde_json::to_vec(&json!({"sessionId":session.as_str(),"cwd":"/workspace","command":"opencode","env":{},"cols":80,"rows":24})).unwrap(),&self.source).unwrap();
        let phone = self
            .office
            .bind(
                self.root.join("api").join(session.as_str()),
                session.clone(),
            )
            .unwrap();
        (nix, plan, request, phone)
    }
    fn retain(&self) -> LaptopWorkflow {
        let (nix, plan, request, phone) = self.resources();
        self.runtime()
            .retain_laptop_network(&nix, plan, request, phone)
            .unwrap_or_else(|_| panic!("real laptop retain"))
    }
    fn count(&self, verb: &str) -> usize {
        fs::read_to_string(self.root.join("trace"))
            .unwrap_or_default()
            .lines()
            .filter(|line| line.starts_with(&format!("network\0{verb}\0")))
            .count()
    }
    fn close_resources(
        &self,
        returned: LaptopNetworkReturned,
    ) -> std::result::Result<(), Arc<LaptopError>> {
        let (nix, _plan, _request, phone, result) = returned.into_parts();
        self.office.close_phone(&phone, end()).unwrap();
        let (guard, storage, outcome) = nix.into_parts();
        outcome.unwrap();
        guard.close().unwrap();
        storage.close(end()).unwrap();
        result
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.office.close(end()).unwrap();
        if let Some(runtime) = &self.runtime {
            let _ = runtime.close(end());
        }
        fs::remove_dir_all(&self.root).unwrap();
    }
}
#[test]
fn actual_network_inspect_create_and_negative_labels_keep_one_shot_real_resources() {
    for (mode, progress, creates) in [
        ("missing", LaptopNetworkProgress::Ready, 1),
        ("existing", LaptopNetworkProgress::Ready, 0),
        ("foreign", LaptopNetworkProgress::Rejected, 0),
        ("malformed", LaptopNetworkProgress::Rejected, 0),
    ] {
        let fixture = Fixture::new(mode);
        let workflow = fixture.retain();
        let actual = fixture
            .runtime()
            .run_laptop_network(&workflow, end())
            .unwrap();
        assert!(
            fixture
                .runtime()
                .run_laptop_network(&workflow, end())
                .is_err()
        );
        let returned = fixture
            .runtime()
            .reclaim_laptop_network(workflow.clone())
            .unwrap_or_else(|_| panic!("settled network must return same owners"));
        let result = fixture.close_resources(returned);
        assert!(fixture.runtime().reclaim_laptop_network(workflow).is_err());
        assert_eq!(actual, progress);
        assert_eq!(fixture.count("inspect"), 1);
        assert_eq!(fixture.count("create"), creates);
        assert_eq!(result.is_ok(), progress == LaptopNetworkProgress::Ready);
    }
}
#[test]
fn failed_actual_creation_retains_resources_and_last_runtime_drop_never_unlocks_them() {
    if crate::test_process::isolate_case(
        "worker_laptop::tests::failed_actual_creation_retains_resources_and_last_runtime_drop_never_unlocks_them",
    ) {
        return;
    }
    let mut fixture = Fixture::new("failed-create");
    let workflow = fixture.retain();
    let result = fixture
        .runtime()
        .run_laptop_network(&workflow, end())
        .unwrap();
    assert_eq!(result, LaptopNetworkProgress::Retained);
    assert!(matches!(
        workflow.failure().unwrap().as_deref(),
        Some(LaptopError::Refused("WORKER_LAPTOP_NETWORK_CREATE_FAILED"))
    ));
    assert!(
        fixture
            .runtime()
            .reclaim_laptop_network(workflow.clone())
            .is_err()
    );
    assert!(fixture.runtime().close(end()).is_err());
    assert!(
        fixture
            .runtime()
            .run_laptop_network(&workflow, end())
            .is_err()
    );
    drop(workflow);
    drop(fixture.runtime.take().unwrap());
    assert!(NixStoreGuard::acquire_migration(&fixture.source, &sid()).is_err());
    assert_eq!(fixture.count("create"), 1);
    assert!(fixture.root.join("created-network").exists());
}
#[test]
fn real_office_must_match_the_actual_runtime_and_constructor_fixed_session() {
    let fixture = Fixture::new("missing");
    let other = Fixture::new("missing");
    let (nix, plan, request, phone) = fixture.resources();
    assert!(
        phone
            .assert_runtime_session(other.runtime(), &sid())
            .is_err()
    );
    assert!(
        phone
            .assert_runtime_session(
                fixture.runtime(),
                &ProfileSessionId::parse("00000000-0000-0000-0000-000000000000").unwrap()
            )
            .is_err()
    );
    phone.request_close();
    let failure = fixture
        .runtime()
        .retain_laptop_network(&nix, plan, request, phone)
        .err()
        .unwrap();
    let (plan, request, phone, error) = failure.into_parts();
    let nix = fixture
        .runtime()
        .reclaim_nix_store(nix)
        .unwrap_or_else(|_| panic!("refused inputs leave original Nix owners"));
    assert!(matches!(
        error,
        LaptopError::Office(crate::office::OfficeError::Closed)
    ));
    fixture
        .close_resources(LaptopNetworkReturned {
            resources: Resources {
                nix,
                plan,
                request,
                office: phone,
            },
            outcome: Ok(()),
        })
        .unwrap();
    assert_eq!(fixture.count("inspect"), 0);
    assert_eq!(fixture.count("create"), 0);
}

#[test]
fn cancelled_actual_create_retains_the_same_native_call_resources_and_original_stop_budget() {
    if crate::test_process::isolate_case(
        "worker_laptop::tests::cancelled_actual_create_retains_the_same_native_call_resources_and_original_stop_budget",
    ) {
        return;
    }
    let fixture = Fixture::new("blocked-create");
    let workflow = fixture.retain();
    let runtime = fixture.runtime().clone();
    let call = workflow.clone();
    let task = std::thread::spawn(move || {
        runtime.run_laptop_network(&call, Instant::now() + Duration::from_secs(20))
    });
    let setup = Instant::now() + Duration::from_secs(3);
    while !fixture.root.join("create-entered").exists() && Instant::now() < setup {
        std::thread::sleep(Duration::from_millis(1));
    }
    let entered = fixture.root.join("create-entered").exists();
    let retained = fixture
        .runtime()
        .reclaim_laptop_network(workflow.clone())
        .is_err();
    let locked = NixStoreGuard::acquire_migration(&fixture.source, &sid()).is_err();
    let first = fixture.runtime().request_stop();
    if !entered {
        fs::write(fixture.root.join("release-create"), b"failure-path cleanup").unwrap();
    }
    let result = task.join().unwrap().unwrap();
    let stopped = fixture.runtime().close(end());
    let same_deadline = fixture.runtime().request_stop() == first;
    assert!(entered && retained && locked);
    assert_eq!(result, LaptopNetworkProgress::Retained);
    assert!(stopped.is_err() && same_deadline);
    assert!(
        fixture
            .runtime()
            .reclaim_laptop_network(workflow.clone())
            .is_err()
    );
    assert!(matches!(
        workflow.failure().unwrap().as_deref(),
        Some(LaptopError::Engine(_))
    ));
    assert_eq!(fixture.count("create"), 1);
    assert!(fixture.root.join("created-network").exists());
}

#[test]
fn unknown_first_record_does_not_hide_later_held_record_at_first_stop() {
    if crate::test_process::isolate_case(
        "worker_laptop::tests::unknown_first_record_does_not_hide_later_held_record_at_first_stop",
    ) {
        return;
    }
    let fixture = Fixture::new("failed-create");
    let unknown = fixture.retain();
    assert_eq!(
        fixture
            .runtime()
            .run_laptop_network(&unknown, end())
            .unwrap(),
        LaptopNetworkProgress::Retained
    );
    let session = ProfileSessionId::parse("11111111-2222-4333-8444-555555555555").unwrap();
    let (nix, plan, request, phone) = fixture.resources_for(&session);
    let unused = fixture
        .runtime()
        .retain_laptop_network(&nix, plan, request, phone)
        .unwrap_or_else(|_| panic!("actual second held record"));
    assert!(fixture.runtime().close(end()).is_err());
    let returned = fixture
        .runtime()
        .reclaim_laptop_network(unused)
        .unwrap_or_else(|_| panic!("later cancelled owner must remain reclaimable"));
    assert!(matches!(
        fixture.close_resources(returned).err().as_deref(),
        Some(LaptopError::Refused("WORKER_LAPTOP_STOPPED"))
    ));
    assert!(fixture.runtime().reclaim_laptop_network(unknown).is_err());
    assert_eq!(fixture.count("create"), 1);
}
