//! Actual Runtime/employee lease/observed plan and real supervised census.
use super::*;
use crate::worker_storage::cold_tmp::Admission;
use std::collections::BTreeSet;

fn source(tree: &Tree) -> EffectiveWorkerConfig {
    let mut raw: Value =
        serde_json::from_slice(&worker_config::encode_config(&selected(tree))).unwrap();
    for (name, value) in [
        ("version", json!(1)),
        ("socket", json!("/run/owned-cold.sock")),
        ("companyRoot", json!(tree.0.join("company"))),
        ("apiSocketRoot", json!(tree.0.join("api"))),
        ("budgetMode", json!("pool")),
        ("memoryMiB", json!(0)),
        ("poolMemoryMiB", json!(8192)),
        ("poolTasksMax", json!(512)),
        ("cgroupParent", json!("owned.slice")),
        ("pidsLimit", json!(128)),
        ("cpus", json!(0)),
        ("maintenanceSessions", json!([])),
        (
            "coldTemporaryCleanup",
            json!({"version":1,"enabled":true,"hostLeaseDirectories":[]}),
        ),
    ] {
        raw[name] = value;
    }
    config(raw)
}
fn runtime(tree: &Tree) -> WorkerRuntime {
    let selected = tree.0.join("cold-admission");
    stdfs::hard_link(crate::engine_metadata::tests::program(), &selected).unwrap();
    let bootstrap =
        EngineBootstrap::from_service(selected.as_os_str(), BTreeMap::new(), tree.0.clone())
            .unwrap();
    WorkerRuntime::new(InstalledWorkerEngine::new(bootstrap), &base())
}
fn start(
    tree: &Tree,
    runtime: &WorkerRuntime,
) -> (
    LaunchStorage,
    crate::worker_launch::ObservedCreatePlan,
    BTreeSet<(u64, u64)>,
) {
    let source = source(tree);
    let mut owner = runtime
        .resolve_storage(&source, &session(A))
        .unwrap()
        .acquire()
        .unwrap_or_else(|_| panic!("actual employee lease"));
    owner.prepare_cold_launch_storage().unwrap();
    let target = owner.prepare_temporary().unwrap();
    let plan = runtime
        .prepare_laptop_plan(source.clone(), source, &owner)
        .unwrap();
    let info = stdfs::metadata(target).unwrap();
    (owner, plan, BTreeSet::from([(info.dev(), info.ino())]))
}
#[test]
fn complete_empty_census_uses_actual_lease_and_fixed_double_inventory() {
    if crate::test_process::isolate_case(
        "worker_storage::tests::owner::cold_admission::complete_empty_census_uses_actual_lease_and_fixed_double_inventory",
    ) {
        return;
    }
    let tree = Tree::new();
    let runtime = runtime(&tree);
    let (owner, plan, keys) = start(&tree, &runtime);
    tree.write(&tree.0.join("ps.out"), b"");
    let result = Admission::default().observe(&runtime, &owner, &plan, &keys, end());
    owner.close(end()).unwrap();
    runtime.close(end()).unwrap();
    result.unwrap();
    assert_eq!(
        stdfs::read_to_string(tree.0.join("calls.txt")).unwrap(),
        "ps\0--all\0--quiet\0--no-trunc\nps\0--all\0--quiet\0--no-trunc\n"
    );
}
#[test]
fn stopped_prior_name_and_second_projection_drift_refuse_real_census() {
    if crate::test_process::isolate_case(
        "worker_storage::tests::owner::cold_admission::stopped_prior_name_and_second_projection_drift_refuse_real_census",
    ) {
        return;
    }
    for prior in [false, true] {
        let tree = Tree::new();
        let runtime = runtime(&tree);
        let (owner, plan, keys) = start(&tree, &runtime);
        let id = "f".repeat(64);
        tree.write(&tree.0.join("ps.out"), id.as_bytes());
        let mut row = json!([{"Id":id,"Name":if prior{format!("/fixture-agent-{A}")}else{"/owned-unrelated".to_owned()},"State":{"Running":false,"Paused":false,"Restarting":false,"Pid":0},"Mounts":[]}]);
        tree.write(
            &tree.0.join("inspect.out"),
            &serde_json::to_vec(&row).unwrap(),
        );
        if !prior {
            row[0]["State"]["StartedAt"] = json!("changed");
            tree.write(
                &tree.0.join("inspect.next"),
                &serde_json::to_vec(&row).unwrap(),
            );
        }
        let error = Admission::default()
            .observe(&runtime, &owner, &plan, &keys, end())
            .unwrap_err();
        owner.close(end()).unwrap();
        runtime.close(end()).unwrap();
        assert_eq!(
            error.code(),
            if prior {
                "WORKER_COLD_PRIOR_LAPTOP_PRESENT"
            } else {
                "WORKER_COLD_NATIVE_CHANGED"
            }
        );
    }
}
#[test]
fn changed_current_intent_and_wrong_runtime_refuse_before_any_engine_call() {
    if crate::test_process::isolate_case(
        "worker_storage::tests::owner::cold_admission::changed_current_intent_and_wrong_runtime_refuse_before_any_engine_call",
    ) {
        return;
    }
    let tree = Tree::new();
    let runtime = runtime(&tree);
    let (owner, plan, keys) = start(&tree, &runtime);
    let other = super::runtime(&tree);
    assert!(
        Admission::default()
            .observe(&other, &owner, &plan, &keys, end())
            .is_err()
    );
    tree.company(A, "null", false);
    assert_eq!(
        Admission::default()
            .observe(&runtime, &owner, &plan, &keys, end())
            .unwrap_err()
            .code(),
        "WORKER_COLD_RUNNING_INTENT_CHANGED"
    );
    assert!(!tree.0.join("calls.txt").exists());
    owner.close(end()).unwrap();
    runtime.close(end()).unwrap();
    other.close(end()).unwrap();
}

#[test]
fn actual_clear_retains_a_referenced_tree_before_publishing_pending() {
    if crate::test_process::isolate_case(
        "worker_storage::tests::owner::cold_admission::actual_clear_retains_a_referenced_tree_before_publishing_pending",
    ) {
        return;
    }
    let tree = Tree::new();
    let runtime = runtime(&tree);
    let (mut owner, plan, _) = start(&tree, &runtime);
    let target = owner.paths().scratch().join("tmp");
    let payload = target.join("owned");
    tree.write(&payload, b"preserve because referenced");
    let referenced = crate::native::open_at(
        nix::libc::AT_FDCWD,
        target.as_os_str(),
        nix::libc::O_RDONLY | nix::libc::O_DIRECTORY,
    )
    .unwrap();
    tree.write(&tree.0.join("ps.out"), b"");
    let result = crate::worker_storage::cold_tmp::clear_transaction(
        &runtime,
        &mut owner,
        &plan,
        &mut Admission::default(),
        Instant::now() + Duration::from_secs(10),
    );
    assert!(result.is_err());
    assert!(
        !owner
            .paths()
            .root()
            .join("cold-tmp-cleanup.pending.json")
            .exists()
    );
    assert_eq!(
        stdfs::read(&payload).unwrap(),
        b"preserve because referenced"
    );
    crate::native::close(referenced).unwrap();
    owner.close(end()).unwrap();
    runtime.close(end()).unwrap();
}

#[test]
fn actual_clear_in_owned_pid_mount_namespace_commits_complete_then_releases_fence() {
    const CASE: &str = "worker_storage::tests::owner::cold_admission::actual_clear_in_owned_pid_mount_namespace_commits_complete_then_releases_fence";
    if crate::test_process::isolate_cold_namespace(CASE) {
        return;
    }
    let tree = Tree::new();
    let runtime = runtime(&tree);
    let (mut owner, plan, _) = start(&tree, &runtime);
    let target = owner.paths().scratch().join("tmp");
    let before = stdfs::metadata(&target).unwrap();
    tree.mkdir(&target.join("nested"));
    tree.write(&target.join("nested/payload"), b"owned disposable data");
    tree.write(&owner.paths().home().join("durable"), b"preserve home");
    tree.write(&tree.0.join("ps.out"), b"");
    let result = crate::worker_storage::cold_tmp::clear_transaction(
        &runtime,
        &mut owner,
        &plan,
        &mut Admission::default(),
        Instant::now() + Duration::from_secs(10),
    );
    let report = match result {
        Ok(report) => report,
        Err(error) => {
            owner.close(end()).unwrap();
            runtime.close(end()).unwrap();
            panic!("actual clear: {error:?}")
        }
    };
    assert_eq!(report.entries, 2);
    assert_eq!(report.key, (before.dev(), before.ino()));
    assert_eq!(report.digest.len(), 64);
    assert_eq!(stdfs::read_dir(&target).unwrap().count(), 0);
    assert_eq!(stdfs::metadata(&target).unwrap().ino(), before.ino());
    assert_eq!(
        stdfs::read(owner.paths().home().join("durable")).unwrap(),
        b"preserve home"
    );
    assert!(
        !owner
            .paths()
            .root()
            .join("cold-tmp-cleanup.pending.json")
            .exists()
    );
    assert_eq!(
        stdfs::read_dir(owner.paths().root())
            .unwrap()
            .filter(|entry| entry
                .as_ref()
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with("cold-tmp-complete-"))
            .count(),
        1
    );
    owner.close(end()).unwrap();
    runtime.close(end()).unwrap();
}
