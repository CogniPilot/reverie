use super::*;
use crate::captured_client::{
    CancellationToken, CapturedCall, CapturedClient, Policy, test_hooks::Gate,
};
use crate::worker_runtime::RuntimeError;

struct Pending<'a> {
    client: &'a CapturedClient,
    gate: Arc<Gate>,
    call: CapturedCall,
    root: &'a Path,
}
impl Drop for Pending<'_> {
    fn drop(&mut self) {
        let _ = fs::write(self.root.join("release-metadata"), b"owned");
        self.gate.released.store(true, Ordering::Release);
        let _ = self.client.settle_call(&self.call, end());
    }
}
fn pending_metadata<'a>(
    runtime: &'a WorkerRuntime,
    tree: &'a Tree,
    gate: Arc<Gate>,
) -> Pending<'a> {
    gate.entered.store(false, Ordering::Release);
    gate.released.store(false, Ordering::Release);
    let client = &runtime.installed_engine().engine.client;
    let cancellation = CancellationToken::new();
    let failure = std::thread::scope(|scope| {
        let query = scope.spawn(|| {
            client.run_scoped(
                ["ps", "-aq", "--no-trunc"].map(Into::into).to_vec(),
                Instant::now() + Duration::from_secs(20),
                &cancellation,
                Policy {
                    maximum: Duration::from_secs(20),
                    maximum_output: 4 * 1024 * 1024,
                    successful_exit: true,
                },
            )
        });
        let ceiling = end();
        while !gate.entered.load(Ordering::Acquire) && Instant::now() < ceiling {
            std::thread::sleep(Duration::from_millis(1));
        }
        let entered = gate.entered.load(Ordering::Acquire);
        cancellation.cancel();
        if !entered {
            gate.released.store(true, Ordering::Release);
        }
        let failed = query.join().unwrap().err().unwrap();
        assert!(
            entered,
            "owned metadata constructor actually reached its gate"
        );
        failed
    });
    let pending = Pending {
        client,
        gate,
        call: failure.call.unwrap(),
        root: &tree.root,
    };
    assert!(pending.gate.entered.load(Ordering::Acquire));
    assert!(failure.error.is_uncertain());
    pending
}

#[test]
fn unknown_nix_record_does_not_skip_other_owned_constructor_or_later_record_at_global_stop() {
    let tree = Tree::new();
    let gate = Arc::new(Gate::default());
    gate.released.store(true, Ordering::Release);
    let runtime = tree.runtime(
        "unknown-create",
        Hooks {
            gate: Some(gate.clone()),
            ..Hooks::default()
        },
    );
    let unknown = tree.retain(&runtime, 'a');
    assert_eq!(
        runtime.run_nix_store(&unknown).unwrap(),
        NixProgress::Retained
    );
    let later = tree.retain_session(&runtime, 'b', "11111111-2222-4333-8444-555555555555");
    let pending = pending_metadata(&runtime, &tree, gate);
    let error = runtime.close(Instant::now()).unwrap_err();
    let RuntimeError::Finalization { primary, secondary } = error else {
        panic!("missing typed dual failure: {error:?}");
    };
    assert!(matches!(*primary, RuntimeError::Nix(_)));
    assert!(matches!(*secondary, RuntimeError::Engine(ref error) if error.is_uncertain()));
    let (guard, storage, outcome) = returned(&runtime, later);
    assert!(outcome.is_err());
    guard.close().unwrap();
    drop(pending);
    storage.close(end()).unwrap();
    assert!(runtime.close(end()).is_err());
    assert_eq!(count(&tree, "create"), 1);
    assert_eq!(count(&tree, "rm"), 0);
    assert!(NixStoreGuard::acquire_migration(&tree.source('a'), unknown.session()).is_err());
}

#[test]
fn global_stop_still_settles_later_held_record_after_an_earlier_unknown_helper() {
    let tree = Tree::new();
    let runtime = tree.runtime("unknown-create", Hooks::default());
    let unknown = tree.retain(&runtime, 'a');
    assert_eq!(
        runtime.run_nix_store(&unknown).unwrap(),
        NixProgress::Retained
    );
    let later = tree.retain_session(&runtime, 'b', "11111111-2222-4333-8444-555555555555");
    assert!(matches!(runtime.close(end()), Err(RuntimeError::Nix(_))));
    let (guard, storage, result) = returned(&runtime, later);
    assert!(result.is_err());
    close_resources(guard, storage);
    assert!(runtime.reclaim_nix_store(unknown).is_err());
    assert_eq!(count(&tree, "create"), 1);
    assert_eq!(count(&tree, "rm"), 0);
}
