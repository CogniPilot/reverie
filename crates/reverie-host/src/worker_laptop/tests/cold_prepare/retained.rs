//! Actual pre-Office retained publication, genuine Nix/employee lease/plan,
//! real namespace/proc observations and unchanged nonempty old data.
use super::*;
mod faults;
mod finish;
use std::os::unix::fs::symlink;
fn isolate(name: &str) -> bool {
    crate::test_process::isolate_cold_namespace(&format!(
        "worker_laptop::tests::cold_prepare::retained::{name}"
    ))
}
fn inputs(fixture: &mut Fixture) -> (NixWorkflow, ObservedCreatePlan, WorkerRequest, PathBuf) {
    policy(fixture, "retain-and-replace");
    employee(fixture);
    let (nix, plan, request) = fixture.resources_before_office(&sid(), fixture.source.clone());
    let target = plan.storage().scratch().join("tmp");
    fs::DirBuilder::new()
        .mode(0o700)
        .recursive(true)
        .create(&target)
        .unwrap();
    (nix, plan, request, target)
}
fn prepare(fixture: &Fixture, nix: &NixWorkflow, plan: &ObservedCreatePlan) {
    if let Err(error) = fixture
        .runtime()
        .prepare_retained_cold_tmp(nix, plan, end())
    {
        panic!("real retained preparation: {error:?}");
    }
}
fn envelope(plan: &ObservedCreatePlan) -> PathBuf {
    let root = plan
        .storage()
        .scratch()
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join(".reverie-retained-tmp")
        .join(format!("employee-{}", plan.storage().identity()));
    let entries = fs::read_dir(root)
        .unwrap()
        .collect::<std::io::Result<Vec<_>>>()
        .unwrap();
    assert_eq!(entries.len(), 1);
    entries[0].path()
}
fn deep_payload(target: &Path) -> PathBuf {
    let mut deep = target.join("nested");
    for _ in 0..140 {
        deep = deep.join("d");
        fs::create_dir(&deep).unwrap();
    }
    fs::write(deep.join("last"), b"deep data").unwrap();
    deep.strip_prefix(target).unwrap().to_owned()
}
#[test]
fn real_prepare_preserves_nonempty_special_deep_sparse_tree_before_office() {
    if isolate("real_prepare_preserves_nonempty_special_deep_sparse_tree_before_office") {
        return;
    }
    let mut fixture = Fixture::new("created-cold");
    let (nix, plan, request, target) = inputs(&mut fixture);
    let old = fs::metadata(&target).unwrap();
    fs::create_dir(target.join("nested")).unwrap();
    fs::write(
        target.join("nested/.keep"),
        b"deep marker retained without walking",
    )
    .unwrap();
    fs::write(target.join("binary"), b"\0legacy\xff").unwrap();
    fs::hard_link(target.join("binary"), target.join("hardlink")).unwrap();
    symlink("/outside/never-followed", target.join("symlink")).unwrap();
    nix::unistd::mkfifo(&target.join("fifo"), nix::sys::stat::Mode::S_IRUSR).unwrap();
    fs::File::create(target.join("huge-sparse"))
        .unwrap()
        .set_len(3 << 30)
        .unwrap();
    let deep = deep_payload(&target);
    prepare(&fixture, &nix, &plan);
    let retired = envelope(&plan);
    let data = retired.join("data");
    assert_eq!(
        (
            fs::metadata(&data).unwrap().dev(),
            fs::metadata(&data).unwrap().ino()
        ),
        (old.dev(), old.ino())
    );
    assert_ne!(fs::metadata(&target).unwrap().ino(), old.ino());
    assert_eq!(fs::metadata(&target).unwrap().mode() & 0o7777, 0o700);
    assert_eq!(fs::read_dir(&target).unwrap().count(), 0);
    assert_eq!(fs::read(data.join("binary")).unwrap(), b"\0legacy\xff");
    assert_eq!(
        fs::metadata(data.join("binary")).unwrap().ino(),
        fs::metadata(data.join("hardlink")).unwrap().ino()
    );
    assert_eq!(
        fs::metadata(data.join("huge-sparse")).unwrap().len(),
        3 << 30
    );
    assert_eq!(
        fs::read(data.join(deep).join("last")).unwrap(),
        b"deep data"
    );
    assert_eq!(
        fs::read_link(data.join("symlink")).unwrap(),
        PathBuf::from("/outside/never-followed")
    );
    assert!(retired.join(".keep").is_file());
    let pending = plan.storage().root().join("cold-tmp-cleanup.pending.json");
    let raw = fs::read(&pending).unwrap();
    let intent: serde_json::Value = serde_json::from_slice(&raw).unwrap();
    assert_eq!(intent["state"], "RETIREMENT_INTENT");
    assert_eq!(intent["deepTreeInspected"], false);
    assert_eq!(intent["oldDataDeleted"], false);
    let trace = fs::read(fixture.root.join("trace")).unwrap();
    assert!(
        fixture
            .runtime()
            .prepare_retained_cold_tmp(&nix, &plan, end())
            .is_err()
    );
    assert_eq!(fs::read(&pending).unwrap(), raw);
    assert_eq!(fs::read(fixture.root.join("trace")).unwrap(), trace);
    let phone = fixture
        .office
        .bind(fixture.root.join("api").join(SID), sid())
        .unwrap();
    let workflow = fixture
        .runtime()
        .retain_laptop_network(&nix, plan, request, phone)
        .unwrap_or_else(|failure| panic!("same real retained proof moves: {:?}", failure.cause()));
    fixture
        .runtime()
        .run_laptop_network(&workflow, end())
        .unwrap();
    assert!(matches!(
        fixture
            .runtime()
            .prepare_laptop_cold_temporary(&workflow, end())
            .unwrap(),
        ColdPreparation::Prepared(_)
    ));
    assert_eq!(fs::read(&pending).unwrap(), raw);
    // A generic fresh preparation still cannot adopt this actual owner's fence.
    assert!(
        workflow
            .record
            .try_lock()
            .unwrap()
            .resources()
            .storage()
            .require_no_cold_pending()
            .is_err()
    );
}
#[test]
fn native_failures_before_intent_before_move_and_after_move_keep_old_data_and_one_attempt() {
    if isolate(
        "native_failures_before_intent_before_move_and_after_move_keep_old_data_and_one_attempt",
    ) {
        return;
    }
    for fail in [1, 3, 5] {
        let mut fixture = Fixture::new("created-cold");
        let (nix, plan, _request, target) = inputs(&mut fixture);
        fs::write(target.join("payload"), b"must retain all bytes").unwrap();
        let old = fs::metadata(&target).unwrap();
        fs::write(fixture.root.join("cold-fail-ps-at"), fail.to_string()).unwrap();
        assert!(
            fixture
                .runtime()
                .prepare_retained_cold_tmp(&nix, &plan, end())
                .is_err()
        );
        let pending = plan.storage().root().join("cold-tmp-cleanup.pending.json");
        assert_eq!(pending.exists(), fail != 1);
        let data = if fail == 5 {
            envelope(&plan).join("data")
        } else {
            target.clone()
        };
        assert_eq!(fs::metadata(&data).unwrap().ino(), old.ino());
        assert_eq!(
            fs::read(data.join("payload")).unwrap(),
            b"must retain all bytes"
        );
        let trace = fs::read(fixture.root.join("trace")).unwrap();
        assert!(
            fixture
                .runtime()
                .prepare_retained_cold_tmp(&nix, &plan, end())
                .is_err()
        );
        assert_eq!(fs::read(fixture.root.join("trace")).unwrap(), trace);
        assert!(!fixture.root.join("created-network").exists());
    }
}
#[test]
fn direct_markers_and_original_deadline_refuse_before_any_retirement() {
    if isolate("direct_markers_and_original_deadline_refuse_before_any_retirement") {
        return;
    }
    for marker in [Some(".keep"), Some(".reverie-task.json"), None] {
        let mut fixture = Fixture::new("created-cold");
        let (nix, plan, _request, target) = inputs(&mut fixture);
        fs::write(target.join("payload"), b"unchanged").unwrap();
        if let Some(marker) = marker {
            fs::write(target.join(marker), b"preserve").unwrap();
        }
        let old = fs::metadata(&target).unwrap();
        let deadline = if marker.is_none() {
            Instant::now() - Duration::from_secs(1)
        } else {
            end()
        };
        assert!(
            fixture
                .runtime()
                .prepare_retained_cold_tmp(&nix, &plan, deadline)
                .is_err()
        );
        assert_eq!(fs::metadata(&target).unwrap().ino(), old.ino());
        assert_eq!(fs::read(target.join("payload")).unwrap(), b"unchanged");
        assert!(
            !plan
                .storage()
                .root()
                .join("cold-tmp-cleanup.pending.json")
                .exists()
        );
        assert!(!fixture.root.join("cold-ps.count").exists());
    }
}
