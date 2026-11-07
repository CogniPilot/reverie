//! Real private mount/PID namespace backs the canonical fresh-/tmp proof.
//! The controlled fixed engine only returns this fixture's actual data.
use super::*;
mod faults;
use nix::mount::{MsFlags, mount, umount};
struct TmpBind {
    active: bool,
}
impl TmpBind {
    fn new(target: &Path) -> Self {
        assert_eq!(std::process::id(), 1, "own private namespace only");
        assert!(
            !target.starts_with("/tmp"),
            "fixture/control files must survive the actual /tmp mount"
        );
        mount(
            Some(target),
            "/tmp",
            None::<&str>,
            MsFlags::MS_BIND,
            None::<&str>,
        )
        .unwrap();
        Self { active: true }
    }
    fn close(mut self) {
        umount("/tmp").unwrap();
        self.active = false;
    }
}
impl Drop for TmpBind {
    fn drop(&mut self) {
        if self.active {
            let _ = umount("/tmp");
        }
    }
}
fn configured(
    fixture: &Fixture,
    nix: &NixWorkflow,
    plan: ObservedCreatePlan,
    request: WorkerRequest,
) -> (LaptopWorkflow, ConfiguredMemory) {
    let phone = fixture
        .office
        .bind(fixture.root.join("api").join(SID), sid())
        .unwrap();
    let workflow = fixture
        .runtime()
        .retain_laptop_network(nix, plan, request, phone)
        .unwrap_or_else(|failure| panic!("actual move: {:?}", failure.cause()));
    assert_eq!(
        fixture
            .runtime()
            .run_laptop_network(&workflow, end())
            .unwrap(),
        LaptopNetworkProgress::Ready
    );
    assert!(matches!(
        fixture
            .runtime()
            .prepare_laptop_cold_temporary(&workflow, end())
            .unwrap(),
        ColdPreparation::Prepared(_)
    ));
    let telemetry = CommandTelemetry::capture(fixture.runtime(), &fixture.source).unwrap();
    let LaptopCreation::Created(created) = fixture
        .runtime()
        .create_laptop(&workflow, &telemetry, end())
        .unwrap()
    else {
        panic!("actual create {:?}", workflow.failure().unwrap());
    };
    fixture.runtime().publish_laptop_launch(&created).unwrap();
    let ContainerStart::Started(started) = fixture
        .runtime()
        .start_laptop_container(&created, end())
        .unwrap()
    else {
        panic!("actual start {:?}", workflow.failure().unwrap());
    };
    let MemoryConfiguration::Configured(configured) = fixture
        .runtime()
        .configure_started_laptop_memory(&started, end())
        .unwrap()
    else {
        panic!("actual memory {:?}", workflow.failure().unwrap());
    };
    (workflow, configured)
}
fn inspection(fixture: &Fixture, target: &Path) -> serde_json::Value {
    let info = fs::metadata(&fixture.root).unwrap();
    json!([{"Id":"c".repeat(64),"Image":format!("sha256:{}","a".repeat(64)),"Name":format!("/fixture-agent-{SID}"),
        "State":{"Running":true,"Paused":false,"Restarting":false,"Pid":std::process::id(),"StartedAt":"owned-start"},
        "Config":{"User":format!("{}:{}",info.uid(),info.gid()),"Entrypoint":["/bin/sleep"],"Cmd":["infinity"],
            "Labels":{"reverie.worker":"fixture","reverie.session":SID,"reverie.employee":"11111111-2222-4333-8444-555555555555"}},
        "Mounts":[{"Type":"bind","Source":target,"Destination":"/tmp","RW":true}]}])
}
#[test]
fn actual_retained_chain_confirms_real_fresh_mount_before_last_fence_release() {
    if isolate("finish::actual_retained_chain_confirms_real_fresh_mount_before_last_fence_release")
    {
        return;
    }
    let mut fixture = Fixture::new("created-retained");
    let (nix, plan, request, target) = inputs(&mut fixture);
    fs::write(target.join("legacy-bytes"), b"\0old owned bytes\xff").unwrap();
    let original = fs::metadata(&target).unwrap();
    prepare(&fixture, &nix, &plan);
    let retired = envelope(&plan);
    let control = plan.storage().root().to_owned();
    let pending = control.join("cold-tmp-cleanup.pending.json");
    assert!(pending.is_file());
    let (workflow, configured) = configured(&fixture, &nix, plan, request);
    let binding = TmpBind::new(&target);
    fs::write(
        fixture.root.join("retained-inspect.json"),
        serde_json::to_vec(&inspection(&fixture, &target)).unwrap(),
    )
    .unwrap();
    let ColdCommit::Committed(committed) = fixture
        .runtime()
        .commit_started_laptop_cold(&configured, end())
        .unwrap()
    else {
        panic!("actual retained commit: {:?}", workflow.failure().unwrap());
    };
    assert!(committed.same_workflow(&workflow));
    assert!(!pending.exists());
    assert!(retired.join(".keep").is_file());
    assert_eq!(
        fs::metadata(retired.join("data")).unwrap().ino(),
        original.ino()
    );
    assert_eq!(
        fs::read(retired.join("data/legacy-bytes")).unwrap(),
        b"\0old owned bytes\xff"
    );
    let records = fs::read_dir(&control)
        .unwrap()
        .filter_map(|entry| {
            let entry = entry.unwrap();
            let name = entry.file_name();
            let name = name.to_str().unwrap();
            (name.starts_with("cold-tmp-retained-")
                && !name.starts_with("cold-tmp-retained-ready-"))
            .then(|| entry.path())
        })
        .collect::<Vec<_>>();
    assert_eq!(records.len(), 1);
    let bound: serde_json::Value = serde_json::from_slice(&fs::read(&records[0]).unwrap()).unwrap();
    assert_eq!(
        bound["state"],
        "OLD_TMP_RETAINED_FRESH_TMP_BOUND_PENDING_RELEASE"
    );
    assert_eq!(bound["nativeContainer"]["pid"], std::process::id());
    assert_eq!(bound["oldDataDeleted"], false);
    assert_eq!(bound["deepTreeInspected"], false);
    let trace = fs::read(fixture.root.join("trace")).unwrap();
    assert!(
        fixture
            .runtime()
            .commit_started_laptop_cold(&configured, end())
            .is_err()
    );
    assert_eq!(fs::read(fixture.root.join("trace")).unwrap(), trace);
    binding.close();
}
#[test]
fn real_mount_is_required_and_wrong_actual_cid_never_releases_prepared_fence() {
    if isolate("finish::real_mount_is_required_and_wrong_actual_cid_never_releases_prepared_fence")
    {
        return;
    }
    for wrong_cid in [false, true] {
        let mut fixture = Fixture::new("created-retained");
        let (nix, plan, request, target) = inputs(&mut fixture);
        fs::write(target.join("payload"), b"retained").unwrap();
        prepare(&fixture, &nix, &plan);
        let retired = envelope(&plan);
        let pending = plan.storage().root().join("cold-tmp-cleanup.pending.json");
        let expected = fs::read(&pending).unwrap();
        let (workflow, configured) = configured(&fixture, &nix, plan, request);
        let mut row = inspection(&fixture, &target);
        if wrong_cid {
            row[0]["Id"] = json!("f".repeat(64));
        }
        fs::write(
            fixture.root.join("retained-inspect.json"),
            serde_json::to_vec(&row).unwrap(),
        )
        .unwrap();
        assert!(matches!(
            fixture
                .runtime()
                .commit_started_laptop_cold(&configured, end())
                .unwrap(),
            ColdCommit::Rejected
        ));
        assert_eq!(fs::read(&pending).unwrap(), expected);
        assert_eq!(fs::read(retired.join("data/payload")).unwrap(), b"retained");
        let trace = fs::read(fixture.root.join("trace")).unwrap();
        assert!(
            fixture
                .runtime()
                .commit_started_laptop_cold(&configured, end())
                .is_err()
        );
        assert_eq!(fs::read(fixture.root.join("trace")).unwrap(), trace);
        assert!(workflow.failure().unwrap().is_some());
    }
}
