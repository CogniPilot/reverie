use super::*;

fn query(
    client: &CapturedClient,
    end: Instant,
    token: &CancellationToken,
) -> std::result::Result<CapturedOutput, super::super::super::CallFailure> {
    client.run_scoped_waiting(
        vec!["owned-success".into()],
        end,
        token,
        Policy {
            maximum: Duration::from_secs(20),
            maximum_output: 4096,
            successful_exit: true,
        },
    )
}

#[test]
fn concurrent_successful_calls_wait_before_admission_without_replay() {
    let tree = Tree::new();
    let gate = Arc::new(Gate::default());
    let hooks = Hooks {
        gate: Some(gate.clone()),
        ..Hooks::default()
    };
    let starts = hooks.starts.clone();
    let waited = hooks.admission_waited.clone();
    let client = tree.client(hooks);
    let engine = crate::engine_metadata::ReadonlyEngine {
        client: client.clone(),
    };
    let first_owner = engine.capture_query_owner();
    let second_owner = engine.capture_query_owner();
    let first = std::thread::spawn(move || {
        first_owner.query(
            crate::engine_metadata::EngineQuery::InventoryIds,
            end(),
            &CancellationToken::new(),
        )
    });
    wait(&gate.entered);
    let second = std::thread::spawn(move || {
        second_owner.query(
            crate::engine_metadata::EngineQuery::InventoryIds,
            end(),
            &CancellationToken::new(),
        )
    });
    let until = end();
    while !waited.load(Ordering::Acquire) && !second.is_finished() && Instant::now() < until {
        std::thread::sleep(Duration::from_millis(1));
    }
    let before = starts.load(Ordering::Acquire);
    gate.released.store(true, Ordering::Release);
    let first = first.join().unwrap();
    let second = second.join().unwrap();
    client.close(end()).unwrap();
    assert!(first.is_ok());
    assert!(
        second.is_ok(),
        "sibling must wait, not refuse: {:?}",
        second.as_ref().err()
    );
    assert_eq!(first.unwrap(), "ps\0-aq\0--no-trunc");
    assert_eq!(second.unwrap(), "ps\0-aq\0--no-trunc");
    assert_eq!(before, 1);
    assert_eq!(starts.load(Ordering::Acquire), 2);
}

#[test]
fn immediate_scope_leaves_preadmission_waiting_with_the_original_effect_owner() {
    let tree = Tree::new();
    let gate = Arc::new(Gate::default());
    let hooks = Hooks {
        gate: Some(gate.clone()),
        ..Hooks::default()
    };
    let starts = hooks.starts.clone();
    let client = tree.client(hooks);
    let engine = crate::engine_metadata::ReadonlyEngine {
        client: client.clone(),
    };
    let owner = engine.capture_query_owner();
    let original = std::thread::spawn(move || {
        owner.query(
            crate::engine_metadata::EngineQuery::InventoryIds,
            end(),
            &CancellationToken::new(),
        )
    });
    wait(&gate.entered);
    let pending = client.run_scoped(
        vec!["must-not-spawn".into()],
        Instant::now() + Duration::from_millis(60),
        &CancellationToken::new(),
        Policy {
            maximum: Duration::from_secs(20),
            maximum_output: 4096,
            successful_exit: true,
        },
    );
    let calls = starts.load(Ordering::Acquire);
    gate.released.store(true, Ordering::Release);
    let completed = original.join().unwrap();
    client.close(end()).unwrap();
    assert_eq!(completed.unwrap(), "ps\0-aq\0--no-trunc");
    let pending = pending.err().unwrap();
    assert_eq!(pending.error.fault, EngineFault::Busy);
    assert!(pending.call.is_none() && !pending.error.may_have_started);
    assert_eq!(
        calls, 1,
        "the outer owner still controls whether and when to wait"
    );
    assert_eq!(
        starts.load(Ordering::Acquire),
        1,
        "no effect replay or sibling cancellation"
    );
}

#[test]
fn waiting_admission_deadline_and_cancellation_never_spawn_or_settle_sibling() {
    let tree = Tree::new();
    let hooks = Hooks::default();
    let starts = hooks.starts.clone();
    let waited = hooks.admission_waited.clone();
    let client = tree.client(hooks);
    let active = client.active.lock().unwrap();
    let worker = client.clone();
    let expires = Instant::now() + Duration::from_millis(60);
    let expired = std::thread::spawn(move || query(&worker, expires, &CancellationToken::new()))
        .join()
        .unwrap()
        .err()
        .unwrap();
    let token = CancellationToken::new();
    let cancel = token.clone();
    let worker = client.clone();
    waited.store(false, Ordering::Release);
    let cancelled = std::thread::spawn(move || query(&worker, end(), &token));
    wait(&waited);
    cancel.cancel();
    let cancelled = cancelled.join().unwrap().err().unwrap();
    drop(active);
    client.close(end()).unwrap();
    assert_eq!(expired.error.fault, EngineFault::Deadline);
    assert_eq!(cancelled.error.fault, EngineFault::Cancelled);
    assert!(expired.call.is_none() && cancelled.call.is_none());
    assert_eq!(starts.load(Ordering::Acquire), 0);
}

#[test]
fn poisoned_admission_still_refuses_without_native_work() {
    let tree = Tree::new();
    let hooks = Hooks::default();
    let starts = hooks.starts.clone();
    let client = tree.client(hooks);
    let poison = client.clone();
    assert!(
        std::thread::spawn(move || {
            let _guard = poison.active.lock().unwrap();
            panic!("owned poison");
        })
        .join()
        .is_err()
    );
    let failure = query(&client, end(), &CancellationToken::new())
        .err()
        .unwrap();
    assert!(failure.error.is_uncertain());
    assert!(failure.call.is_none());
    assert_eq!(starts.load(Ordering::Acquire), 0);
    assert!(client.close(end()).is_err());
}
