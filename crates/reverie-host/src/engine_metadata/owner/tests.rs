//! Exact shared-client origin and real checked-close fault controls. No Docker,
//! root policy, peer/current-owner grant or physical resource release is used.
use super::*;
use std::{
    collections::BTreeSet,
    io::{Read, Seek, Write},
    os::fd::AsRawFd,
    os::unix::fs::OpenOptionsExt,
};
fn native_descriptors() -> BTreeSet<i32> {
    // readlink does not open a directory/descriptor. The fixture asserts real
    // reuse within this finite test scan; it is not a process-census authority.
    (0..4096)
        .filter(|fd| {
            fs::read_link(format!("/proc/self/fd/{fd}")).is_ok_and(|target| {
                let raw = target.as_os_str().as_encoded_bytes();
                raw.starts_with(b"pipe:[") || raw.starts_with(b"socket:[")
            })
        })
        .collect()
}
#[test]
fn scoped_owner_checks_actual_engine_before_native_admission_and_keeps_fixed_optional_inspection() {
    let tree = Tree::new();
    let bootstrap = tree.bootstrap("argv");
    let starts = bootstrap.hooks.starts.clone();
    let engine = ReadonlyEngine::new(bootstrap);
    let foreign = tree.engine("other-argv");
    let owner = engine.capture_query_owner();
    assert_eq!(
        owner.assert_engine(&foreign).unwrap_err().fault(),
        EngineFault::Identity
    );
    assert_eq!(starts.load(Ordering::SeqCst), 0);
    let result = owner
        .query(
            EngineQuery::InventoryIds,
            deadline(),
            &CancellationToken::new(),
        )
        .unwrap();
    assert_eq!(result, "ps\0-aq\0--no-trunc");
    let name = laptop_name();
    let named = owner
        .inspect_laptop(&name, deadline(), &CancellationToken::new())
        .unwrap();
    assert!(named.succeeded);
    assert_eq!(
        named.stdout,
        format!("inspect\0{}", name.as_str()).as_bytes()
    );
    owner.settle_owned(deadline()).unwrap();
    assert_eq!(starts.load(Ordering::SeqCst), 2);
    let failure = tree.engine("failure");
    let optional = failure.capture_query_owner();
    let named = optional
        .inspect_laptop(&name, deadline(), &CancellationToken::new())
        .unwrap();
    assert!(!named.succeeded, "original optional nonzero remains DATA");
    optional.settle_owned(deadline()).unwrap();
    engine.close(deadline()).unwrap();
    foreign.close(deadline()).unwrap();
    failure.close(deadline()).unwrap();
}
#[test]
fn scoped_consumed_close_uncertainty_keeps_original_ticket_and_refuses_native_replay() {
    let tree = Tree::new();
    let mut bootstrap = tree.bootstrap("close");
    let failed = bootstrap.hooks.close_failed.clone();
    let starts = bootstrap.hooks.starts.clone();
    let gate = Arc::new(Gate::default());
    bootstrap.hooks.gate = Some(gate.clone());
    failed.store(true, Ordering::SeqCst);
    let engine = ReadonlyEngine::new(bootstrap);
    let before = native_descriptors();
    let owner = Arc::new(engine.capture_query_owner());
    let query_owner = owner.clone();
    let query = std::thread::spawn(move || {
        query_owner.query(
            EngineQuery::InventoryIds,
            deadline(),
            &CancellationToken::new(),
        )
    });
    let ceiling = deadline();
    while !gate.entered.load(Ordering::Acquire) && Instant::now() < ceiling {
        std::thread::sleep(Duration::from_millis(1));
    }
    let entered = gate.entered.load(Ordering::Acquire);
    let actual_native = native_descriptors()
        .difference(&before)
        .copied()
        .collect::<BTreeSet<_>>();
    gate.released.store(true, Ordering::Release);
    let error = query.join().unwrap().unwrap_err();
    failed.store(false, Ordering::SeqCst);
    let mut foreign = fs::OpenOptions::new()
        .create_new(true)
        .read(true)
        .write(true)
        .mode(0o600)
        .open(tree.root.join("foreign-reused-descriptor"))
        .unwrap();
    let reused = actual_native.contains(&foreign.as_raw_fd());
    foreign
        .write_all(b"owned foreign bytes survive repeated settlement")
        .unwrap();
    let cleanup = owner.settle_owned(deadline());
    let repeated = owner
        .query(
            EngineQuery::InventoryIds,
            deadline(),
            &CancellationToken::new(),
        )
        .unwrap_err();
    let global = engine.close(deadline());
    foreign.rewind().unwrap();
    let mut bytes = Vec::new();
    let read = foreign.read_to_end(&mut bytes);
    let closed = crate::native::close(foreign);
    assert!(
        entered && reused,
        "must reuse an actual descriptor observed in this native job"
    );
    read.unwrap();
    closed.unwrap();
    assert_eq!(bytes, b"owned foreign bytes survive repeated settlement");
    assert!(error.is_uncertain() && error.cleanup_faults().contains(&CleanupFault::StdoutClose));
    assert!(
        cleanup.is_err() && global.is_err(),
        "consumed-close uncertainty cannot be forgiven"
    );
    assert_eq!(repeated, error, "original native body error remains exact");
    assert_eq!(
        starts.load(Ordering::SeqCst),
        1,
        "no native query is reissued"
    );
}
#[test]
fn scoped_known_native_failure_stays_latched_after_settlement_without_poisoning_fresh_owner() {
    let tree = Tree::new();
    let bootstrap = tree.bootstrap("failure");
    let starts = bootstrap.hooks.starts.clone();
    let engine = ReadonlyEngine::new(bootstrap);
    let owner = engine.capture_query_owner();
    let error = owner
        .query(
            EngineQuery::InventoryIds,
            deadline(),
            &CancellationToken::new(),
        )
        .unwrap_err();
    let settled = owner.settle_owned(deadline());
    let repeated = owner
        .query(
            EngineQuery::InventoryIds,
            deadline(),
            &CancellationToken::new(),
        )
        .unwrap_err();
    let before_fresh = starts.load(Ordering::SeqCst);
    let fresh = engine.capture_query_owner();
    let optional = fresh
        .inspect_laptop(&laptop_name(), deadline(), &CancellationToken::new())
        .unwrap();
    let fresh_settled = fresh.settle_owned(deadline());
    let closed = engine.close(deadline());
    assert!(!error.is_uncertain());
    settled.unwrap();
    assert_eq!(repeated, error);
    assert_eq!(
        before_fresh, 1,
        "same failed owner cannot issue another native call"
    );
    assert!(!optional.succeeded);
    assert_eq!(
        starts.load(Ordering::SeqCst),
        2,
        "fresh exact context can use the shared client"
    );
    fresh_settled.unwrap();
    closed.unwrap();
}
