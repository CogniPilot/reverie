//! Real registered lease and captured native census owners; no engine/host
//! effects, live PID, capacity credit, Q intent or stopped-release authority.
use super::super::tests::*;
use super::StoppedRamSource;
use crate::reservation_observer::{NativeObserver, StoppedRamPresence};

fn source(tree: &Tree) -> EffectiveWorkerConfig {
    let mut raw: serde_json::Value =
        serde_json::from_slice(&worker_config::encode_config(&tree.source())).unwrap();
    for (name, value) in [
        ("budgetMode", json!("admission")),
        ("memoryMiB", json!(512)),
        ("pidsLimit", json!(128)),
        ("cpus", json!(0)),
        ("poolMemoryMiB", json!(4096)),
        ("poolTasksMax", json!(1024)),
    ] {
        raw[name] = value;
    }
    worker_config::decode(&serde_json::to_vec(&raw).unwrap()).unwrap()
}
fn enable(tree: &Tree, config: &EffectiveWorkerConfig, present: bool) {
    let mut row = json!({
        "Id":"c".repeat(64),"Name":format!("/fixture-agent-{SID}"),
        "Image":format!("sha256:{}","a".repeat(64)),
        "Config":{"Labels":{"reverie.worker":"fixture","reverie.session":SID,
            "reverie.employee":EID,"reverie.worker-policy":worker_config::policy_digest(config).to_hex()}},
        "State":{"Running":false,"Pid":0},"Mounts":[],
        "HostConfig":{"Memory":512*1_048_576_u64,"MemorySwap":512*1_048_576_u64,
            "PidsLimit":128,"NanoCpus":0}
    });
    tree.write("ram-row.out", &serde_json::to_vec(&row).unwrap());
    row["State"] = json!({"Running":false,"Pid":0,"Status":"exited",
        "StartedAt":"2026-11-07T00:00:00Z","Paused":false,"Restarting":false,"Dead":false});
    tree.write("ram-stopped.out", &serde_json::to_vec(&row).unwrap());
    tree.write(
        "ram-ids.out",
        if present {
            b"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc\n"
        } else {
            b""
        },
    );
    tree.write("stopped-ram-control", b"fixed native census fixture only");
}
fn begin(
    claim: StorageClaim,
    registry: &StorageRegistry,
    config: EffectiveWorkerConfig,
) -> StoppedRamSource {
    let context = NativeObserver::capture_worker(&registry.runtime, config);
    claim
        .begin_stopped_ram_source(context)
        .map_err(|failure| failure.into_parts().2.to_string())
        .unwrap()
}
fn finish(owner: StoppedRamSource, registry: &StorageRegistry, expected: Option<&str>) {
    let (claim, primary) = owner
        .restore_unclaimed(end())
        .map_err(|failure| failure.into_parts().1.to_string())
        .unwrap()
        .into_parts();
    assert_eq!(primary.as_ref().map(|error| error.code()), expected);
    assert_eq!(registry.entries.lock().unwrap().len(), 1);
    claim.release(end()).unwrap();
    registry.runtime.close(end()).unwrap();
}

#[test]
fn present_stopped_finite_declarations_and_complete_absence_are_distinct_with_same_lease() {
    crate::test_process::owning_case!(
        present_stopped_finite_declarations_and_complete_absence_are_distinct_with_same_lease
    );
    for present in [true, false] {
        let tree = Tree::new();
        let registry = tree.registry();
        let config = source(&tree);
        let claim = registry.claim(&config, &sid(SID)).unwrap();
        enable(&tree, &config, present);
        let mut owner = begin(claim, &registry, config.clone());
        let observed = owner.observe().unwrap();
        assert!(StorageLease::acquire_launch(&config, &sid(SID)).is_err());
        match observed.presence() {
            StoppedRamPresence::PresentStopped(row) => {
                assert!(present);
                assert_eq!(row.declaration().container_id().as_str(), "c".repeat(64));
                assert_eq!(row.declaration().memory().as_str(), "536870912");
                assert!(!row.state_bytes().is_empty());
                assert_eq!(row.metadata_digest().to_hex().len(), 64);
            }
            StoppedRamPresence::Absent => assert!(!present),
        }
        owner.assert_current().unwrap();
        assert!(
            owner.observe().is_err(),
            "one actual observation, never replay"
        );
        finish(owner, &registry, None);
        let lease = StorageLease::acquire_launch(&config, &sid(SID)).unwrap();
        lease.close().unwrap();
        let trace = fs::read_to_string(tree.0.join("calls.txt")).unwrap();
        assert_eq!(
            trace
                .lines()
                .filter(|line| *line == "ps\0-aq\0--no-trunc")
                .count(),
            4
        );
        assert!(
            !trace
                .lines()
                .any(|line| line.starts_with("stop\0") || line.starts_with("kill\0"))
        );
    }
}

#[test]
fn foreign_engine_capture_refuses_before_same_entry_mutation_or_query() {
    crate::test_process::owning_case!(
        foreign_engine_capture_refuses_before_same_entry_mutation_or_query
    );
    let tree = Tree::new();
    let registry = tree.registry();
    let foreign = tree.registry();
    let config = source(&tree);
    let claim = registry.claim(&config, &sid(SID)).unwrap();
    let before = tree.calls();
    let context = NativeObserver::capture_worker(&foreign.runtime, config);
    let (claim, _context, error) = claim
        .begin_stopped_ram_source(context)
        .err()
        .unwrap()
        .into_parts();
    assert_eq!(error.code(), "ENGINE_METADATA_REFUSED");
    assert_eq!(tree.calls(), before);
    assert!(matches!(
        &registry.entries.lock().unwrap()[0].owner,
        EntryOwner::Direct(_)
    ));
    claim.release(end()).unwrap();
    registry.runtime.close(end()).unwrap();
    foreign.runtime.close(end()).unwrap();
}

#[test]
fn changed_census_is_sticky_but_known_abort_preserves_primary_and_original_lease() {
    crate::test_process::owning_case!(
        changed_census_is_sticky_but_known_abort_preserves_primary_and_original_lease
    );
    let tree = Tree::new();
    let registry = tree.registry();
    let config = source(&tree);
    let claim = registry.claim(&config, &sid(SID)).unwrap();
    enable(&tree, &config, true);
    tree.write("ram-ids.next", b"");
    let mut owner = begin(claim, &registry, config.clone());
    let error = owner.observe().err().unwrap();
    let before = tree.calls();
    assert_eq!(error.code(), "RAM_STOPPED_COMPLETE_CENSUS_CHANGED");
    assert_eq!(owner.assert_current().err().unwrap().code(), error.code());
    assert_eq!(owner.observe().err().unwrap().code(), error.code());
    assert_eq!(
        tree.calls(),
        before,
        "failure cannot issue replacement metadata"
    );
    assert!(StorageLease::acquire_launch(&config, &sid(SID)).is_err());
    finish(owner, &registry, Some(error.code()));
}

#[test]
fn selected_foreign_binding_live_pid_malformed_name_and_wrong_hard_refuse_without_absence() {
    crate::test_process::owning_case!(
        selected_foreign_binding_live_pid_malformed_name_and_wrong_hard_refuse_without_absence
    );
    for (path, value, expected) in [
        (
            "/Config/Labels/reverie.employee",
            json!("22222222-2222-4333-8444-555555555555"),
            "RAM_STOPPED_SOURCE_IDENTITY",
        ),
        ("/State/Pid", json!(42), "RESERVATION_STOPPED_ROW"),
        ("/Name", json!(null), "RESERVATION_COMPLETE_INVENTORY"),
        (
            "/HostConfig/Memory",
            json!(1024 * 1_048_576_u64),
            "RESERVATION_NATIVE_FINITE_LIMITS",
        ),
    ] {
        let tree = Tree::new();
        let registry = tree.registry();
        let config = source(&tree);
        let claim = registry.claim(&config, &sid(SID)).unwrap();
        enable(&tree, &config, true);
        for file in ["ram-row.out", "ram-stopped.out"] {
            let mut row: serde_json::Value =
                serde_json::from_slice(&fs::read(tree.0.join(file)).unwrap()).unwrap();
            *row.pointer_mut(path).unwrap() = value.clone();
            tree.write(file, &serde_json::to_vec(&row).unwrap());
        }
        let mut owner = begin(claim, &registry, config.clone());
        let error = owner.observe().err().unwrap();
        assert_eq!(error.code(), expected);
        assert!(StorageLease::acquire_launch(&config, &sid(SID)).is_err());
        assert!(!registry.known_empty_for_service_drop());
        finish(owner, &registry, Some(expected));
    }
}

#[test]
fn actual_paused_native_query_releases_global_registry_but_fences_stale_alias() {
    crate::test_process::owning_case!(
        actual_paused_native_query_releases_global_registry_but_fences_stale_alias
    );
    let tree = Tree::new();
    let registry = tree.registry();
    let config = source(&tree);
    let claim = registry.claim(&config, &sid(SID)).unwrap();
    let alias = {
        let entries = registry.entries.lock().unwrap();
        registry.handle(&entries[0], false)
    };
    enable(&tree, &config, true);
    let mut owner = begin(claim, &registry, config);
    tree.write("ram-hold.next", b"pause actual first native census");
    let (send, receive) = std::sync::mpsc::channel();
    let (owner, result, progress, started) = std::thread::scope(|scope| {
        let query = scope.spawn(move || {
            let result = owner.observe();
            (owner, result)
        });
        let ceiling = Instant::now() + Duration::from_secs(5);
        while !tree.0.join("ram-query-started").exists() && Instant::now() < ceiling {
            std::thread::sleep(Duration::from_millis(2));
        }
        let started = tree.0.join("ram-query-started").exists();
        let registry = &registry;
        let reader = scope.spawn(move || {
            let count = registry.entries.lock().unwrap().len();
            let refused = alias.release(end()).err().unwrap();
            send.send((count, refused.cause().code().to_owned()))
                .unwrap();
        });
        let progress = receive.recv_timeout(Duration::from_secs(1));
        tree.write(
            "ram-query-release",
            b"owned child can finish before assertions",
        );
        let (owner, result) = query.join().unwrap();
        reader.join().unwrap();
        (owner, result, progress, started)
    });
    let success = result.is_ok();
    finish(owner, &registry, None);
    assert!(started && success);
    assert_eq!(progress.unwrap(), (1, "RAM_STOPPED_SOURCE_RETAINED".into()));
}
