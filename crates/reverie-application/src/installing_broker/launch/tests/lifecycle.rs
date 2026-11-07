//! Real accepted J scopes and real resource factories drive lifecycle controls.
//! No container is created or claimed stopped by these bookkeeping assertions.
use super::*;
use crate::installing_broker::lifecycle::{ActiveLaunchToken, LaunchGeneration};
const FIRST: &str = "11111111-2222-3333-4444-555555555555";
const SECOND: &str = "22222222-2222-3333-4444-555555555555";
const THIRD: &str = "33333333-2222-3333-4444-555555555555";
fn actual_scope<'a>(
    broker: &'a InstallingBroker,
    sid: &str,
) -> (
    UnixStream,
    AdmittedWorkerLaunch<'a>,
    StorageClaim,
    LaunchGeneration,
) {
    let (client, socket) = incoming_as(broker, b'J', sid, true);
    let WorkerConnectionDispatch::Launch(received) =
        broker.accept_worker_connection(socket).unwrap()
    else {
        panic!("actual J")
    };
    let scope = received.begin_ordinary().unwrap();
    let generation = broker.installed.capture_generation().unwrap();
    assert!(broker.allowed(scope.request().session()).unwrap());
    let storage = broker.claim_storage(scope.request().session()).unwrap();
    (client, scope, storage, generation)
}
fn register<'a>(
    scope: &AdmittedWorkerLaunch<'a>,
    generation: &LaunchGeneration,
) -> ActiveLaunchToken<'a> {
    let broker = scope.request.broker;
    let mut lifecycle = broker.installed.lifecycle().unwrap();
    lifecycle.check_generation(generation).unwrap();
    assert!(broker.allowed(scope.request().session()).unwrap());
    lifecycle.claim_active(generation, scope).unwrap()
}
fn finish(
    scope: AdmittedWorkerLaunch<'_>,
    storage: StorageClaim,
    token: &mut ActiveLaunchToken<'_>,
) {
    scope
        .request
        .broker
        .installed
        .lifecycle()
        .unwrap()
        .finalize_active(token)
        .unwrap();
    scope.close(end()).unwrap();
    storage.release(end()).unwrap();
    token.release_hold(end()).unwrap();
}
fn unreserved(tree: &Tree) -> InstallingBroker {
    let broker = fixture(tree);
    tree.write("company.json", br#"{"employees":[]}"#);
    broker
}
#[test]
fn wrong_origin_refuses_without_poisoning_the_real_scope_and_aba_cannot_remove_its_successor() {
    let tree = Tree::new();
    let broker = unreserved(&tree);
    let other_tree = Tree::new();
    let other = unreserved(&other_tree);
    let (_client, scope, storage, generation) = actual_scope(&broker, FIRST);
    assert!(
        other
            .installed
            .lifecycle()
            .unwrap()
            .claim_active(&generation, &scope)
            .is_err()
    );
    assert_eq!(other.installed.lifecycle().unwrap().entries().count(), 0);
    let mut token = register(&scope, &generation);
    broker
        .installed
        .lifecycle()
        .unwrap()
        .reenter_active(&token, &scope)
        .unwrap();
    broker
        .installed
        .lifecycle()
        .unwrap()
        .finalize_active(&token)
        .unwrap();
    let (_client2, scope2, storage2, generation2) = actual_scope(&broker, FIRST);
    let mut token2 = register(&scope2, &generation2);
    assert!(
        broker
            .installed
            .lifecycle()
            .unwrap()
            .finalize_active(&token)
            .is_err()
    );
    broker
        .installed
        .lifecycle()
        .unwrap()
        .reenter_active(&token2, &scope2)
        .unwrap();
    assert_eq!(broker.installed.lifecycle().unwrap().entries().count(), 1);
    finish(scope2, storage2, &mut token2);
    scope.close(end()).unwrap();
    storage.release(end()).unwrap();
    token.release_hold(end()).unwrap();
    broker.close_command_telemetry(end()).unwrap();
    other.close_command_telemetry(end()).unwrap();
}
#[test]
fn actual_drain_changes_generation_and_finally_clears_draining_without_global_runtime_stop() {
    let tree = Tree::new();
    let broker = unreserved(&tree);
    let (_client, scope, storage, generation) = actual_scope(&broker, FIRST);
    let mut token = register(&scope, &generation);
    {
        let mut lifecycle = broker.installed.lifecycle().unwrap();
        let drain = lifecycle.begin_drain().unwrap();
        assert_eq!(drain.names().len(), 1);
        assert_eq!(drain.connections().len(), 1);
        assert!(Arc::ptr_eq(
            &drain.connections()[0],
            &scope.request.connection
        ));
        assert!(drain.check_generation(&generation).is_err());
    }
    let current = broker.installed.capture_generation().unwrap();
    {
        let lifecycle = broker.installed.lifecycle().unwrap();
        lifecycle.check_generation(&current).unwrap();
        assert!(lifecycle.check_generation(&generation).is_err());
        assert!(lifecycle.reenter_active(&token, &scope).is_err());
    }
    assert!(!broker.storage.runtime.cancellation().is_cancelled());
    finish(scope, storage, &mut token);
    let (_client, next, storage, generation) = actual_scope(&broker, FIRST);
    let mut token = register(&next, &generation);
    finish(next, storage, &mut token);
    broker.close_command_telemetry(end()).unwrap();
}
#[test]
fn unwind_resets_only_the_drain_flag_and_keeps_the_advanced_generation() {
    let tree = Tree::new();
    let broker = unreserved(&tree);
    let generation = broker.installed.capture_generation().unwrap();
    {
        let mut lifecycle = broker.installed.lifecycle().unwrap();
        assert!(
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let _drain = lifecycle.begin_drain().unwrap();
                panic!("owned stop-all body refusal");
            }))
            .is_err()
        );
    }
    let current = broker.installed.capture_generation().unwrap();
    let lifecycle = broker.installed.lifecycle().unwrap();
    lifecycle.check_generation(&current).unwrap();
    assert!(lifecycle.check_generation(&generation).is_err());
    drop(lifecycle);
    assert!(broker.storage.runtime.stop_deadline().is_none());
    broker.close_command_telemetry(end()).unwrap();
}
#[test]
fn actual_pending_j_refuses_recovery_before_an_empty_native_census_or_office_constructor() {
    crate::test_process::owning_case!(
        actual_pending_j_refuses_recovery_before_an_empty_native_census_or_office_constructor
    );
    let tree = Tree::new();
    let mut raw: serde_json::Value = serde_json::from_slice(&tree.raw).unwrap();
    raw.as_object_mut().unwrap().remove("resourceReservations");
    tree.write("worker.json", &serde_json::to_vec(&raw).unwrap());
    fs::remove_file(tree.root.join("state/resource-reservation-control.json")).unwrap();
    tree.write("company.json", br#"{"employees":[]}"#);
    tree.write("names.out", b"");
    tree.write("ids.out", b"");
    let snapshot = load_owner_config(&tree.root.join("worker.json")).unwrap();
    let bootstrap = EngineBootstrap::from_service(
        super::super::super::recovered::tests::program().as_os_str(),
        BTreeMap::new(),
        tree.root.clone(),
    )
    .unwrap();
    let runtime = WorkerRuntime::new(
        InstalledWorkerEngine::new(bootstrap),
        snapshot.envelope().base(),
    );
    let broker = InstallingBroker::new(snapshot, runtime).unwrap();
    let (_client, scope, storage, generation) = actual_scope(&broker, FIRST);
    let mut token = register(&scope, &generation);
    assert_eq!(
        broker.recover_laptops().err().unwrap().to_string(),
        "WORKER_RECOVERY_LAUNCH_IN_PROGRESS"
    );
    assert!(
        !tree.root.join("calls.txt").exists(),
        "zero native census constructors"
    );
    assert!(
        !tree.root.join("office").exists(),
        "zero actual Office constructors"
    );
    assert!(
        broker.installed.lifecycle().unwrap().guard.is_empty(),
        "no committed owner from a pending name"
    );
    finish(scope, storage, &mut token);
    broker.close_command_telemetry(end()).unwrap();
}
#[test]
fn real_recovered_owners_and_pending_name_overlay_keep_unique_original_sid_order() {
    crate::test_process::owning_case!(
        real_recovered_owners_and_pending_name_overlay_keep_unique_original_sid_order
    );
    let tree = super::super::super::recovered::tests::Tree::new(&format!("{FIRST}\n{SECOND}\n"));
    tree.broker.recover_laptops().unwrap();
    let (_client, first, first_storage, first_generation) = actual_scope(&tree.broker, FIRST);
    let mut first_token = register(&first, &first_generation);
    let (_client, third, third_storage, third_generation) = actual_scope(&tree.broker, THIRD);
    let mut third_token = register(&third, &third_generation);
    {
        let lifecycle = tree.broker.installed.lifecycle().unwrap();
        let entries = lifecycle
            .entries()
            .map(|(sid, name)| (sid.as_str().to_owned(), name.as_str().to_owned()))
            .collect::<Vec<_>>();
        assert_eq!(
            entries
                .iter()
                .map(|(sid, _)| sid.as_str())
                .collect::<Vec<_>>(),
            [FIRST, SECOND, THIRD]
        );
        assert_eq!(entries[0].1, format!("test-agent-{FIRST}"));
        assert_eq!(
            lifecycle.guard.len(),
            2,
            "only actual Recovered owners are committed"
        );
    }
    finish(first, first_storage, &mut first_token);
    finish(third, third_storage, &mut third_token);
    assert_eq!(tree.broker.installed.lifecycle().unwrap().guard.len(), 2);
}
#[test]
fn last_broker_drop_retains_actual_pending_state_even_after_its_socket_owner_closes() {
    crate::test_process::owning_case!(
        last_broker_drop_retains_actual_pending_state_even_after_its_socket_owner_closes
    );
    for retain_pending in [false, true] {
        let tree = Tree::new();
        let broker = unreserved(&tree);
        let weak = Arc::downgrade(&broker.installed);
        if retain_pending {
            let (_client, scope, storage, generation) = actual_scope(&broker, FIRST);
            let token = register(&scope, &generation);
            storage.release(end()).unwrap();
            drop(token);
            drop(scope);
        }
        drop(broker);
        assert_eq!(weak.upgrade().is_some(), retain_pending);
    }
}

struct HeldRecovery {
    tree: Arc<super::super::super::recovered::tests::Tree>,
    task: Option<std::thread::JoinHandle<Result<RecoverySummary, RecoveryError>>>,
}
impl HeldRecovery {
    fn release(&mut self) -> Result<RecoverySummary, RecoveryError> {
        fs::write(
            self.tree.root.join("names.release"),
            b"release actual native query",
        )
        .unwrap();
        self.task.take().unwrap().join().unwrap()
    }
}
impl Drop for HeldRecovery {
    fn drop(&mut self) {
        fs::write(
            self.tree.root.join("names.release"),
            b"always release actual native query",
        )
        .unwrap();
        if let Some(task) = self.task.take() {
            let _ = task.join();
        }
    }
}
#[test]
fn recovery_keeps_the_same_lifecycle_guard_between_pending_check_and_publication() {
    crate::test_process::owning_case!(
        recovery_keeps_the_same_lifecycle_guard_between_pending_check_and_publication
    );
    let tree = Arc::new(super::super::super::recovered::tests::Tree::new(""));
    let (_client, scope, storage, generation) = actual_scope(&tree.broker, FIRST);
    fs::write(tree.root.join("names.hold"), b"hold actual readonly census").unwrap();
    let worker = tree.clone();
    let mut held = HeldRecovery {
        tree: tree.clone(),
        task: Some(std::thread::spawn(move || worker.broker.recover_laptops())),
    };
    let until = Instant::now() + Duration::from_secs(3);
    while !tree.root.join("names.started").exists() {
        assert!(Instant::now() < until, "actual native census entry");
        std::thread::sleep(Duration::from_millis(1));
    }
    assert!(
        matches!(
            tree.broker.installed.laptops.try_lock(),
            Err(std::sync::TryLockError::WouldBlock)
        ),
        "the same lifecycle excludes a new active J through publication"
    );
    assert_eq!(held.release().unwrap().registered(), 0);
    let mut token = register(&scope, &generation);
    tree.broker
        .installed
        .lifecycle()
        .unwrap()
        .reenter_active(&token, &scope)
        .unwrap();
    finish(scope, storage, &mut token);
}

#[test]
fn repeated_actual_handler_abandonment_keeps_the_one_transport_cap_counted() {
    crate::test_process::owning_case!(
        repeated_actual_handler_abandonment_keeps_the_one_transport_cap_counted
    );
    let tree = Tree::new();
    let broker = unreserved(&tree);
    let limit = broker.storage.runtime.connection_limit();
    for index in 0..limit {
        let sid = format!("{:08x}-2222-3333-4444-555555555555", index + 1);
        let (_client, scope, storage, generation) = actual_scope(&broker, &sid);
        let token = register(&scope, &generation);
        storage.release(end()).unwrap();
        drop(token);
        drop(scope);
        assert_eq!(
            broker.installed.lifecycle().unwrap().entries().count(),
            index + 1
        );
    }
    let sid = format!("{:08x}-2222-3333-4444-555555555555", limit + 1);
    let (_client, socket) = incoming_as(&broker, b'J', &sid, true);
    assert!(matches!(
        broker.accept_worker_connection(socket),
        Err(WorkerDispatchError::Transport(WorkerReportError::Stopping))
    ));
    assert!(broker.close_command_telemetry(end()).is_err());
}
