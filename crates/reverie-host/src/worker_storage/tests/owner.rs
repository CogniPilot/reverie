use super::*;
use crate::{
    engine_metadata::{CancellationToken, EngineBootstrap, EngineQuery},
    installed_worker_engine::InstalledWorkerEngine,
    worker_runtime::WorkerRuntime,
};
use reverie_core::{
    resources::{BudgetMode, CpuQuota, ResourcePolicy},
    worker_schema::{WorkerBase, WorkerIds},
};
use std::{
    collections::BTreeMap,
    sync::Arc,
    time::{Duration, Instant},
};
fn end() -> Instant {
    Instant::now() + Duration::from_secs(2)
}
fn base() -> WorkerBase {
    WorkerBase::try_new(
        "fixture".into(),
        "fixture-server".into(),
        format!("sha256:{}", "a".repeat(64)),
        WorkerIds::try_new(native::uid(), native::uid()).unwrap(),
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
    .unwrap()
}
fn selected(tree: &Tree) -> EffectiveWorkerConfig {
    let mut raw = tree.raw();
    raw["gid"] = json!(native::uid());
    raw["deployment"] = json!("fixture");
    raw["serverContainer"] = json!("fixture-server");
    raw["maxWorkers"] = json!(4);
    raw["image"] = json!(format!("sha256:{}", "a".repeat(64)));
    config(raw)
}
fn bootstrap(tree: &Tree) -> EngineBootstrap {
    EngineBootstrap::from_service(
        crate::engine_metadata::tests::program().as_os_str(),
        BTreeMap::new(),
        tree.0.clone(),
    )
    .unwrap()
}
fn runtime(tree: &Tree) -> WorkerRuntime {
    WorkerRuntime::new(InstalledWorkerEngine::new(bootstrap(tree)), &base())
}
#[test]
fn actual_legacy_resolution_has_no_broker_lease_or_new_lock_tree() {
    let tree = Tree::new();
    let runtime = runtime(&tree);
    let source = selected(&tree);
    let selection = runtime.resolve_storage(&source, &session(B)).unwrap();
    assert_eq!(
        selection.paths().kind(),
        storage_identity::StorageKind::Session
    );
    let owner = selection.into_legacy().unwrap();
    assert_eq!(owner.ownership_kind(), StorageOwnershipKind::UnleasedLegacy);
    assert_eq!(
        owner.check_resource_current().unwrap(),
        StorageOwnershipKind::UnleasedLegacy
    );
    assert!(
        !tree.state().exists(),
        "legacy resolution never invents an employee lock/registry directory"
    );
    owner.close(end()).unwrap();
    runtime.close(end()).unwrap();
}
#[test]
fn real_owner_binding_preserves_image_refresh_and_rejects_other_origin_or_path_namespace() {
    let tree = Tree::new();
    let runtime = runtime(&tree);
    let source = selected(&tree);
    let owner = runtime
        .resolve_storage(&source, &session(B))
        .unwrap()
        .into_legacy()
        .unwrap();
    let mut changed = tree.raw();
    changed["gid"] = json!(native::uid());
    changed["deployment"] = json!("fixture");
    changed["serverContainer"] = json!("fixture-server");
    changed["maxWorkers"] = json!(4);
    changed["image"] = json!(format!("sha256:{}", "b".repeat(64)));
    changed["memoryMiB"] = json!(3072);
    owner
        .assert_binding(&runtime, &config(changed.clone()), &session(B))
        .unwrap();
    changed["scratchRoot"] = json!(tree.0.join("new-scratch"));
    assert!(
        owner
            .assert_binding(&runtime, &config(changed), &session(B))
            .is_err()
    );
    let other = super::owner::runtime(&tree);
    assert!(owner.assert_binding(&other, &source, &session(B)).is_err());
    owner.close(end()).unwrap();
    runtime.close(end()).unwrap();
    other.close(end()).unwrap();
}
#[test]
fn guard_fresh_resolution_may_change_kind_without_becoming_a_fake_legacy_lease() {
    if crate::test_process::isolate_case(
        "worker_storage::tests::owner::guard_fresh_resolution_may_change_kind_without_becoming_a_fake_legacy_lease",
    ) {
        return;
    }
    let tree = Tree::new();
    let runtime = runtime(&tree);
    let source = selected(&tree);
    let selection = runtime.resolve_storage(&source, &session(A)).unwrap();
    assert_eq!(
        selection.paths().kind(),
        storage_identity::StorageKind::Employee
    );
    tree.write(&tree.0.join("company.json"), br#"{"employees":[]}"#);
    let owner = selection.acquire().unwrap();
    assert_eq!(owner.paths().kind(), storage_identity::StorageKind::Session);
    assert_eq!(owner.ownership_kind(), StorageOwnershipKind::HeldLease);
    assert_eq!(
        owner.check_resource_current().unwrap(),
        StorageOwnershipKind::HeldLease
    );
    assert!(StorageLease::acquire_launch(&source, &session(A)).is_err());
    owner.close(end()).unwrap();
    StorageLease::acquire_launch(&source, &session(A))
        .unwrap()
        .close()
        .unwrap();
    runtime.close(end()).unwrap();
}
#[test]
fn failed_descriptor_close_returns_consumed_unconfirmed_owner_without_retry_or_live_lease() {
    if crate::test_process::isolate_case(
        "worker_storage::tests::owner::failed_descriptor_close_returns_consumed_unconfirmed_owner_without_retry_or_live_lease",
    ) {
        return;
    }
    let tree = Tree::new();
    let runtime = runtime(&tree);
    let source = selected(&tree);
    let owner = runtime
        .resolve_storage(&source, &session(A))
        .unwrap()
        .acquire()
        .unwrap();
    native::test_faults::set(None, true);
    let (owner, cause) = owner.close(end()).unwrap_err().into_parts();
    assert!(matches!(cause, StorageOwnerError::Storage(_)));
    assert_eq!(
        owner.ownership_kind(),
        StorageOwnershipKind::ConsumedUnconfirmed
    );
    assert!(owner.check_resource_current().is_err());
    assert_eq!(
        owner.close(end()).unwrap_err().cause().code(),
        "WORKER_STORAGE_CLOSE_UNCONFIRMED"
    );
    runtime.close(end()).unwrap();
}
#[test]
fn same_context_pending_constructor_keeps_actual_flock_owned_until_settled() {
    if crate::test_process::isolate_case(
        "worker_storage::tests::owner::same_context_pending_constructor_keeps_actual_flock_owned_until_settled",
    ) {
        return;
    }
    let tree = Tree::new();
    let mut bootstrap = bootstrap(&tree);
    let gate = Arc::new(crate::captured_client::test_hooks::Gate::default());
    bootstrap.hooks.gate = Some(gate.clone());
    let runtime = WorkerRuntime::new(InstalledWorkerEngine::new(bootstrap), &base());
    let source = selected(&tree);
    let owner = runtime
        .resolve_storage(&source, &session(A))
        .unwrap()
        .acquire()
        .unwrap();
    let reader = runtime.readonly();
    let task = std::thread::spawn(move || {
        reader.query(
            EngineQuery::InventoryIds,
            Instant::now() + Duration::from_millis(40),
            &CancellationToken::new(),
        )
    });
    let wait = end();
    while !gate.entered.load(Ordering::Acquire) {
        assert!(Instant::now() < wait);
        std::thread::sleep(Duration::from_millis(1));
    }
    assert!(task.join().unwrap().unwrap_err().is_uncertain());
    let (owner, cause) = owner
        .close(Instant::now() + Duration::from_millis(20))
        .unwrap_err()
        .into_parts();
    assert!(matches!(cause, StorageOwnerError::Engine(_)));
    assert_eq!(owner.ownership_kind(), StorageOwnershipKind::HeldLease);
    assert!(StorageLease::acquire_launch(&source, &session(A)).is_err());
    gate.released.store(true, Ordering::Release);
    runtime.settle_owned(end()).unwrap();
    owner.close(end()).unwrap();
    StorageLease::acquire_launch(&source, &session(A))
        .unwrap()
        .close()
        .unwrap();
    runtime.close(end()).unwrap();
}

fn expected_writer_error(case: &Value) -> &str {
    match case["error"].as_str().unwrap() {
        "TypeError" | "AttributeError" | "KeyError" => "WORKER_STORAGE_WRITER_STRUCTURE",
        "JSONDecodeError" | "ValueError" => "WORKER_STORAGE_WRITER_JSON",
        "RuntimeError" => {
            let message = case["message"].as_str().unwrap();
            if message.starts_with("Cannot establish") {
                "WORKER_STORAGE_WRITER_IDS"
            } else if message.contains("inventory changed") {
                "WORKER_STORAGE_WRITER_INVENTORY"
            } else if message.contains("state changed") {
                "WORKER_STORAGE_WRITER_STATE"
            } else if message.starts_with("Employee laptop") {
                "WORKER_CANONICAL_STORAGE_RECREATE"
            } else if message.starts_with("Another running") {
                "WORKER_COMPETING_STORAGE_WRITER"
            } else {
                panic!("unknown actual source message {message}")
            }
        }
        other => panic!("unexpected source class {other}"),
    }
}
fn writer_runtime(tree: &Tree) -> WorkerRuntime {
    let program = tree.0.join("storage-writer");
    stdfs::hard_link(crate::engine_metadata::tests::program(), &program).unwrap();
    WorkerRuntime::new(
        InstalledWorkerEngine::new(
            EngineBootstrap::from_service(program.as_os_str(), BTreeMap::new(), tree.0.clone())
                .unwrap(),
        ),
        &base(),
    )
}
fn writer_case(case: &Value) {
    let tree = Tree::new();
    let runtime = writer_runtime(&tree);
    let source = selected(&tree);
    let owner = runtime
        .resolve_storage(&source, &session(A))
        .unwrap()
        .acquire()
        .unwrap();
    let home = owner.paths().home();
    let nix = owner.paths().nix();
    let parent = home.parent().unwrap();
    tree.mkdir(home);
    tree.mkdir(nix);
    let outside = tree.0.join("outside");
    tree.mkdir(&outside);
    let alias = tree.0.join("home-alias");
    symlink(home, &alias).unwrap();
    let raw = case["inspect"]
        .as_str()
        .unwrap()
        .replace("@HOME@", home.to_str().unwrap())
        .replace("@NIX@", nix.to_str().unwrap())
        .replace("@PARENT@", parent.to_str().unwrap())
        .replace("@OUT@", outside.to_str().unwrap())
        .replace("@ALIAS@", alias.to_str().unwrap());
    tree.write(
        &tree.0.join("ps.out"),
        case["listed"].as_str().unwrap().as_bytes(),
    );
    tree.write(&tree.0.join("inspect.out"), raw.as_bytes());
    let result = runtime.check_storage_writers(&owner, None);
    if case["accepted"].as_bool().unwrap() {
        result.unwrap();
    } else {
        assert_eq!(
            result.unwrap_err().code(),
            expected_writer_error(case),
            "{}",
            case["name"]
        );
    }
    let calls = stdfs::read_to_string(tree.0.join("calls.txt"))
        .unwrap()
        .lines()
        .map(|line| line.split('\0').map(str::to_owned).collect::<Vec<_>>())
        .collect::<Vec<_>>();
    assert_eq!(
        serde_json::to_value(calls).unwrap(),
        case["calls"],
        "{} actual native argv/order",
        case["name"]
    );
    owner.close(end()).unwrap();
    runtime.close(end()).unwrap();
}
#[test]
fn all_actual_python_writer_cases_match_same_native_client_and_real_owned_resolution() {
    if crate::test_process::isolate_case(
        "worker_storage::tests::owner::all_actual_python_writer_cases_match_same_native_client_and_real_owned_resolution",
    ) {
        return;
    }
    let corpus: Value = serde_json::from_str(include_str!(
        "../../../../reverie-contracts/tests/fixtures/storage-writers-python.json"
    ))
    .unwrap();
    for case in corpus["cases"].as_array().unwrap() {
        writer_case(case);
    }
}

#[test]
fn actual_wait_binding_corpus_uses_real_strict_metadata_read_and_preserves_bytes() {
    let corpus: Value = serde_json::from_str(include_str!(
        "../../../../reverie-contracts/tests/fixtures/launch-wait-binding-python.json"
    ))
    .unwrap();
    let sid = ProfileSessionId::parse(corpus["session"].as_str().unwrap()).unwrap();
    for case in corpus["cases"].as_array().unwrap() {
        let tree = Tree::new();
        let source = selected(&tree);
        let raw = case["raw"].as_str().unwrap();
        let bytes = if case["encoding"] == "utf-16" {
            let mut bytes = vec![0xff, 0xfe];
            for word in raw.encode_utf16() {
                bytes.extend_from_slice(&word.to_le_bytes())
            }
            bytes
        } else {
            raw.as_bytes().to_vec()
        };
        tree.write(&tree.0.join("company.json"), &bytes);
        let result = read_launch_wait_binding(&source, &sid);
        if case.get("error").is_some() {
            let error = result.unwrap_err();
            let valid = match case["error"].as_str().unwrap() {
                "AttributeError" | "TypeError" => matches!(
                    error,
                    StorageOwnerError::Data(
                        reverie_contracts::storage_writers::WriterDataError::Structure
                    )
                ),
                "JSONDecodeError" => matches!(error, StorageOwnerError::Identity(_)),
                "ValueError" => matches!(
                    error,
                    StorageOwnerError::Identity(_)
                        | StorageOwnerError::Data(
                            reverie_contracts::storage_writers::WriterDataError::WaitBinding
                        )
                ),
                other => panic!("unknown source error {other}"),
            };
            assert!(valid, "{}: {error:?}", case["name"]);
        } else {
            let binding = result.unwrap();
            assert_eq!(
                binding.as_ref().map(|value| value.bytes()),
                case["binding"].as_str().map(str::as_bytes),
                "{}",
                case["name"]
            );
        }
    }
}

#[test]
fn wait_binding_normalizes_path_spelling_but_refuses_actual_metadata_aliases() {
    let tree = Tree::new();
    let mut raw = tree.raw();
    raw["companyFile"] = json!(format!("{}/./company.json/", tree.0.display()));
    assert!(
        read_launch_wait_binding(&config(raw.clone()), &session(A))
            .unwrap()
            .is_some()
    );
    let alias = tree.0.join("company-alias.json");
    symlink(tree.0.join("company.json"), &alias).unwrap();
    raw["companyFile"] = json!(alias);
    assert!(matches!(
        read_launch_wait_binding(&config(raw), &session(A)),
        Err(StorageOwnerError::Identity(_))
    ));
}
