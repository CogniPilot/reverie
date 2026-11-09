//! Pause the real captured child while exercising the same actual registry.
use super::super::tests::*;

fn source(tree: &Tree) -> EffectiveWorkerConfig {
    let mut raw: serde_json::Value =
        serde_json::from_slice(&worker_config::encode_config(&tree.source())).unwrap();
    for (name, value) in [
        ("memoryMiB", json!(0)),
        ("pidsLimit", json!(128)),
        ("cpus", json!(0)),
        ("budgetMode", json!("pool")),
        ("poolMemoryMiB", json!(4096)),
        ("poolTasksMax", json!(1024)),
        ("apiSocketRoot", json!(tree.0.join("office"))),
        ("companyRoot", json!(tree.0.join("company"))),
        ("cgroupParent", json!("reverie-workers.slice")),
    ] {
        raw[name] = value;
    }
    worker_config::decode(&serde_json::to_vec(&raw).unwrap()).unwrap()
}

#[test]
fn native_final_query_releases_registry_lock_but_keeps_same_entry_fenced() {
    if isolate(
        "installing_broker::storage::tests::direct_finalization_cases::native_final_query_releases_registry_lock_but_keeps_same_entry_fenced",
    ) {
        return;
    }
    let tree = Tree::new();
    let executable = tree.0.join("image-refresh");
    fs::copy(program(), &executable).unwrap();
    let registry = tree.registry_with(&executable, BTreeMap::new());
    let source = source(&tree);
    let mut claim = registry.claim(&source, &sid(SID)).unwrap();
    claim.prepare_cold_launch_storage().unwrap();
    claim.prepare_runtime_directory().unwrap();
    let (alias, plan, second_plan) = {
        let entries = registry.entries.lock().unwrap();
        let entry = &entries[0];
        let EntryOwner::Direct(owner) = &entry.owner else {
            panic!("actual registered direct owner")
        };
        (
            registry.handle(entry, false),
            registry
                .runtime
                .prepare_laptop_plan(source.clone(), source.clone(), owner)
                .unwrap(),
            registry
                .runtime
                .prepare_laptop_plan(source.clone(), source.clone(), owner)
                .unwrap(),
        )
    };
    let mut preparation = claim.retain_direct_final_storage(plan).unwrap();
    let (alias, _original_plan, refused) = alias
        .retain_direct_final_storage(second_plan)
        .err()
        .unwrap()
        .into_parts();
    assert_eq!(refused.code(), "WORKER_DIRECT_STORAGE_RETAINED");
    tree.write(
        "inspect.out",
        &serde_json::to_vec(&json!([{
            "Id":"c".repeat(64), "Name":format!("/fixture-agent-{SID}"),
            "Config":{"Labels":{"reverie.worker":"fixture","reverie.session":SID}},
            "State":{"Running":false}
        }]))
        .unwrap(),
    );
    tree.write("hold.next", b"pause actual next native query");
    let (send, receive) = std::sync::mpsc::channel();
    std::thread::scope(|scope| {
        let query = scope.spawn(move || {
            let observed = preparation.observe();
            (preparation, observed)
        });
        let ceiling = Instant::now() + Duration::from_secs(5);
        while !tree.0.join("query-started").exists() && Instant::now() < ceiling {
            std::thread::sleep(Duration::from_millis(2));
        }
        let started = tree.0.join("query-started").exists();
        let company = reverie_contracts::storage_identity::decode_metadata(
            &fs::read(tree.0.join("company.json")).unwrap(),
        )
        .unwrap();
        let diagnostic = registry.storage_status(&company).unwrap();
        let registry = &registry;
        let reader = scope.spawn(move || {
            let count = registry.entries.lock().unwrap().len();
            let refusal = alias.release(end()).err().unwrap();
            send.send((count, refusal.cause().code().to_owned()))
                .unwrap();
        });
        let progress = receive.recv_timeout(Duration::from_secs(1));
        // Release and join our real child before asserting, including on failure.
        tree.write("query-release", b"owned query may conclude");
        let (preparation, observed) = query.join().unwrap();
        reader.join().unwrap();
        assert!(started, "actual native query reached its pause");
        assert_eq!(
            diagnostic[0].owner_kind,
            reverie_contracts::worker_storage_status::OwnerKind::FinalizingDirect
        );
        assert_eq!(
            diagnostic[0].observation,
            reverie_contracts::worker_storage_status::OwnerObservation::Busy
        );
        assert_eq!(
            progress.unwrap(),
            (1, "WORKER_STORAGE_FINALIZATION_HELD".to_owned())
        );
        let observed = observed.unwrap();
        assert!(!observed.is_live());
        let (_, retained) = preparation
            .finish(&observed, end())
            .map_err(|failure| failure.cause().code().to_owned())
            .unwrap()
            .into_parts();
        assert!(!retained);
    });
    assert!(registry.entries.lock().unwrap().is_empty());
    registry.runtime.close(end()).unwrap();
}
