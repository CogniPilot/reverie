//! Real same-client query custody. Each context shares the actual NativeObserver
//! source, while only its own admitted native ticket may be settled.
use super::super::tests::*;
use crate::reservation_observer::NativeObserver;
#[derive(Clone, Copy)]
enum Earlier {
    None,
    Busy,
    Success,
    Failure,
}
fn exercise(earlier: Earlier) {
    let tree = Tree::new();
    let executable = tree.0.join("image-refresh");
    fs::copy(program(), &executable).unwrap();
    let registry = tree.registry_with(&executable, BTreeMap::new());
    let observer = NativeObserver::new(registry.runtime.readonly());
    let context = observer.capture(tree.source(), None);
    match earlier {
        Earlier::Success => {
            context.inventory(Some(end())).unwrap();
        }
        Earlier::Failure => {
            tree.write("ps.out.status", b"7");
            assert!(context.inventory(Some(end())).is_err());
            fs::remove_file(tree.0.join("ps.out.status")).unwrap();
        }
        Earlier::None | Earlier::Busy => {}
    }
    let clone = context
        .with_inherited(None)
        .with_applied_configuration(tree.source());
    let other = observer.capture(tree.source(), None);
    tree.write(
        "hold.next",
        b"pause actual independently owned context query",
    );
    let query = std::thread::spawn(move || {
        let observed = other.inventory(Some(Instant::now() + Duration::from_secs(10)));
        (other, observed)
    });
    let ceiling = Instant::now() + Duration::from_secs(5);
    while !tree.0.join("query-started").exists() && Instant::now() < ceiling {
        std::thread::sleep(Duration::from_millis(2));
    }
    let started = tree.0.join("query-started").exists();
    let busy = !matches!(earlier, Earlier::Busy) || clone.inventory(Some(end())).is_err();
    let cleanup = clone.settle_stopped_ram(end());
    let not_cancelled = !query.is_finished();
    // All owned child work is released/joined and the actual Runtime is closed
    // before verdict, including an unexpected admission/error path.
    tree.write("query-release", b"actual unrelated child may finish");
    let (other, result) = query.join().unwrap();
    let final_settlement = other.settle_stopped_ram(end());
    let closed = registry.runtime.close(end());
    assert!(started && busy);
    assert!(cleanup.is_ok(), "local cleanup: {cleanup:?}");
    assert!(
        not_cancelled,
        "context cleanup must not cancel unrelated native owner"
    );
    assert!(
        result.is_ok(),
        "unrelated actual query: {}",
        result.err().unwrap()
    );
    final_settlement.unwrap();
    closed.unwrap();
}
#[test]
fn distinct_context_cleanup_preserves_actual_other_context_native_query() {
    crate::test_process::owning_case!(
        distinct_context_cleanup_preserves_actual_other_context_native_query
    );
    exercise(Earlier::None);
}
#[test]
fn before_admission_busy_cleanup_preserves_actual_other_context_native_query() {
    crate::test_process::owning_case!(
        before_admission_busy_cleanup_preserves_actual_other_context_native_query
    );
    exercise(Earlier::Busy);
}
#[test]
fn completed_success_cleanup_preserves_later_actual_other_context_native_query() {
    crate::test_process::owning_case!(
        completed_success_cleanup_preserves_later_actual_other_context_native_query
    );
    exercise(Earlier::Success);
}
#[test]
fn original_failed_ticket_cleanup_preserves_later_actual_other_context_native_query() {
    crate::test_process::owning_case!(
        original_failed_ticket_cleanup_preserves_later_actual_other_context_native_query
    );
    exercise(Earlier::Failure);
}
#[test]
fn original_context_clones_retain_same_inflight_owner_until_actual_query_settles() {
    crate::test_process::owning_case!(
        original_context_clones_retain_same_inflight_owner_until_actual_query_settles
    );
    let tree = Tree::new();
    let executable = tree.0.join("image-refresh");
    fs::copy(program(), &executable).unwrap();
    let registry = tree.registry_with(&executable, BTreeMap::new());
    let observer = NativeObserver::new(registry.runtime.readonly());
    let original = observer.capture(tree.source(), None);
    let clone = original
        .with_inherited(None)
        .with_applied_configuration(tree.source());
    tree.write("hold.next", b"pause actual same-origin native context");
    let query = std::thread::spawn(move || {
        let result = original.inventory(Some(Instant::now() + Duration::from_secs(10)));
        (original, result)
    });
    let ceiling = Instant::now() + Duration::from_secs(5);
    while !tree.0.join("query-started").exists() && Instant::now() < ceiling {
        std::thread::sleep(Duration::from_millis(2));
    }
    let started = tree.0.join("query-started").exists();
    let pending = clone.settle_stopped_ram(end());
    let still_owned = !query.is_finished();
    tree.write(
        "query-release",
        b"same original actual native owner may conclude",
    );
    let (original, result) = query.join().unwrap();
    let finalized = original.settle_stopped_ram(end());
    let late_clone = clone.settle_stopped_ram(end());
    let closed = registry.runtime.close(end());
    assert!(started && still_owned);
    assert!(
        pending.is_err(),
        "clones share original busy owner, not an empty substitute"
    );
    assert!(result.is_ok());
    finalized.unwrap();
    late_clone.unwrap();
    closed.unwrap();
}
