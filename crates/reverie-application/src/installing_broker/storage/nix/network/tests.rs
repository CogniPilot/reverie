use super::*;
use reverie_contracts::worker_launch::WorkerRequest;
use reverie_host::{
    office::OfficeService,
    worker_laptop::LaptopNetworkProgress,
    worker_nix::{NixProgress, NixStoreGuard},
};
use std::{
    net::{IpAddr, Ipv4Addr},
    path::Path,
    process::Command,
    sync::OnceLock,
};
fn executable() -> &'static Path {
    static PROGRAM: OnceLock<PathBuf> = OnceLock::new();
    PROGRAM.get_or_init(|| {
        let root = crate::test_process::fixture_directory("application-laptop-build");
        let source = root.join("child.rs");
        fs::write(
            &source,
            include_str!("../../../../../../reverie-host/tests/support/worker_laptop_child.rs"),
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
fn tree() -> Tree {
    // Keep real Unix socket paths below sun_path even inside the flake's TMPDIR.
    let mut tree = Tree::new();
    let short = tree.0.parent().unwrap().join(format!(
        "ln-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    fs::rename(&tree.0, &short).unwrap();
    tree.0 = short;
    tree
}
fn captured(tree: &Tree) -> crate::worker_validation::ValidatedWorkerSnapshot {
    fs::create_dir(tree.0.join("work")).unwrap();
    let mut raw: serde_json::Value =
        serde_json::from_slice(&worker_config::encode_config(&tree.source())).unwrap();
    for (key, value) in [
        ("version", json!(1)),
        ("socket", json!("/run/reverie-laptop-fixture/worker.sock")),
        ("apiSocketRoot", json!(tree.0.join("api"))),
        ("companyRoot", json!(tree.0.join("company"))),
        ("budgetMode", json!("pool")),
        ("memoryMiB", json!(0)),
        ("poolMemoryMiB", json!(4096)),
        ("poolTasksMax", json!(1024)),
        ("cgroupParent", json!("reverie-workers.slice")),
        ("pidsLimit", json!(128)),
        ("cpus", json!(0)),
        (
            "mounts",
            json!([{"source":tree.0.join("work"),"destination":"/workspace","readOnly":false}]),
        ),
        ("maintenanceSessions", json!([])),
    ] {
        raw[key] = value;
    }
    crate::worker_validation::validate_captured(
        worker_config::decode(&serde_json::to_vec(&raw).unwrap()).unwrap(),
    )
    .unwrap()
}
fn prepared(
    tree: &Tree,
    registry: &Arc<StorageRegistry>,
    snapshot: &crate::worker_validation::ValidatedWorkerSnapshot,
    office: &OfficeService,
) -> (
    super::super::nix::NetworkStoragePreparation,
    Option<StorageClaim>,
) {
    let source = snapshot.configuration();
    let mut claim = registry.claim(source, &sid(SID)).unwrap();
    let alias = if claim.paths().kind() == StorageKind::Employee {
        Some(registry.claim(source, &sid(SID)).unwrap())
    } else {
        None
    };
    claim.prepare_storage().unwrap();
    claim.record_storage_binding().unwrap();
    let plan = claim.prepare_create_plan(snapshot).unwrap();
    let request=WorkerRequest::decode(&serde_json::to_vec(&json!({"sessionId":SID,"cwd":"/workspace","command":"opencode","env":{},"cols":80,"rows":24})).unwrap(),source).unwrap();
    let guard = NixStoreGuard::acquire_launch(source, &sid(SID)).unwrap();
    let nix = claim.retain_nix(guard, source.clone()).unwrap();
    assert_eq!(nix.run().unwrap(), NixProgress::NoHelper);
    let phone = office.bind(tree.0.join("api").join(SID), sid(SID)).unwrap();
    let network = nix
        .retain_network(plan, request, phone)
        .unwrap_or_else(|_| panic!("atomic actual Nix-to-laptop transfer"));
    (network, alias)
}
fn registry(tree: &Tree, mode: &str) -> Arc<StorageRegistry> {
    tree.registry_with(
        executable(),
        BTreeMap::from([("LAPTOP_FIXTURE_MODE".into(), mode.into())]),
    )
}
#[test]
fn actual_registry_moves_nix_to_laptop_and_returns_same_employee_or_legacy_owners_once() {
    crate::test_process::owning_case!(
        actual_registry_moves_nix_to_laptop_and_returns_same_employee_or_legacy_owners_once
    );
    for employee in [false, true] {
        let tree = tree();
        if !employee {
            tree.write("company.json", br#"{"employees":[]}"#);
        }
        let snapshot = captured(&tree);
        let registry = registry(&tree, "missing");
        let office = OfficeService::from_runtime(
            &registry.runtime,
            tree.0.clone(),
            IpAddr::V4(Ipv4Addr::LOCALHOST),
        )
        .unwrap();
        let (network, alias) = prepared(&tree, &registry, &snapshot, &office);
        let paths = network.paths().clone();
        if let Some(alias) = alias {
            let failure = alias.release(end()).unwrap_err();
            let (_retained, error) = failure.into_parts();
            assert_eq!(error.code(), "WORKER_LAPTOP_STORAGE_RETAINED");
            assert!(matches!(
                registry.entries.lock().unwrap()[0].owner,
                EntryOwner::Laptop(_)
            ));
        } else {
            assert!(registry.entries.lock().unwrap().is_empty());
            assert!(!tree.0.join("state/storage-locks").exists());
        }
        assert_eq!(network.run(end()).unwrap(), LaptopNetworkProgress::Ready);
        assert!(network.run(end()).is_err());
        let returned = network
            .reclaim()
            .unwrap_or_else(|_| panic!("known network owner return"));
        let (nix, _plan, _request, phone, outcome) = returned.into_parts();
        outcome.unwrap();
        let (claim, guard, nix_outcome) = nix.into_parts();
        nix_outcome.unwrap();
        assert_eq!(claim.paths(), &paths);
        office.close_phone(&phone, end()).unwrap();
        guard.close().unwrap();
        claim.release(end()).unwrap();
        office.close(end()).unwrap();
        registry.runtime.close(end()).unwrap();
        assert!(registry.entries.lock().unwrap().is_empty());
    }
}
#[test]
fn unknown_network_native_outcome_never_restores_direct_registry_or_releases_lifetime_guard() {
    crate::test_process::owning_case!(
        unknown_network_native_outcome_never_restores_direct_registry_or_releases_lifetime_guard
    );
    let tree = tree();
    let snapshot = captured(&tree);
    let registry = registry(&tree, "failed-create");
    let office = OfficeService::from_runtime(
        &registry.runtime,
        tree.0.clone(),
        IpAddr::V4(Ipv4Addr::LOCALHOST),
    )
    .unwrap();
    let (network, alias) = prepared(&tree, &registry, &snapshot, &office);
    assert_eq!(network.run(end()).unwrap(), LaptopNetworkProgress::Retained);
    let failure = network.reclaim().err().unwrap();
    let (network, _error) = failure.into_parts();
    assert!(network.run(end()).is_err());
    drop(network);
    assert!(alias.unwrap().release(end()).is_err());
    assert!(NixStoreGuard::acquire_migration(snapshot.configuration(), &sid(SID)).is_err());
    assert!(registry.runtime.close(end()).is_err());
    assert!(matches!(
        registry.entries.lock().unwrap()[0].owner,
        EntryOwner::Laptop(_)
    ));
    office.close(end()).unwrap();
}

#[test]
fn actual_network_client_runs_outside_registry_lock_and_stop_retains_its_real_resources() {
    crate::test_process::owning_case!(
        actual_network_client_runs_outside_registry_lock_and_stop_retains_its_real_resources
    );
    let tree = tree();
    let snapshot = captured(&tree);
    let registry = registry(&tree, "blocked-create");
    let office = OfficeService::from_runtime(
        &registry.runtime,
        tree.0.clone(),
        IpAddr::V4(Ipv4Addr::LOCALHOST),
    )
    .unwrap();
    let (network, alias) = prepared(&tree, &registry, &snapshot, &office);
    let network = Arc::new(network);
    let call = network.clone();
    let ceiling = Instant::now() + Duration::from_secs(20);
    let task = std::thread::spawn(move || call.run(ceiling));
    let setup = Instant::now() + Duration::from_secs(3);
    while !tree.0.join("create-entered").exists() && Instant::now() < setup {
        std::thread::sleep(Duration::from_millis(1));
    }
    let entered = tree.0.join("create-entered").exists();
    let unlocked = registry.entries.try_lock().is_ok();
    let first = registry.runtime.request_stop();
    if !entered {
        tree.write("release-create", b"failure-path cleanup");
    }
    let progress = task.join().unwrap().unwrap();
    let network = Arc::try_unwrap(network).unwrap_or_else(|_| panic!("actual call handle joined"));
    let retained = network.reclaim().is_err();
    let release_refused = alias.unwrap().release(end()).is_err();
    let stopped = registry.runtime.close(end());
    office.close(end()).unwrap();
    assert!(entered && unlocked && retained && release_refused);
    assert_eq!(progress, LaptopNetworkProgress::Retained);
    assert!(stopped.is_err());
    assert_eq!(registry.runtime.request_stop(), first);
}
