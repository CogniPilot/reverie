use super::*;
use std::sync::atomic::AtomicUsize;
#[derive(Default)]
pub(super) struct Hooks {
    gate: Option<Arc<Gate>>,
    starts: AtomicUsize,
}
#[derive(Default)]
struct Gate {
    entered: AtomicBool,
    released: AtomicBool,
}
impl Hooks {
    pub(super) fn before_start(&self) {
        self.starts.fetch_add(1, Ordering::SeqCst);
        if let Some(gate) = &self.gate {
            gate.entered.store(true, Ordering::Release);
            while !gate.released.load(Ordering::Acquire) {
                std::thread::sleep(Duration::from_millis(1));
            }
        }
    }
}
fn deadline() -> Instant {
    Instant::now() + Duration::from_secs(2)
}
#[test]
fn timed_out_constructor_stays_owned_and_late_child_is_exactly_reaped() {
    let program = crate::worker_child::tests::program();
    let prepared = PreparedExec::new(program, &["stall".into()], &[]).unwrap();
    let gate = Arc::new(Gate::default());
    let hooks = Hooks {
        gate: Some(Arc::clone(&gate)),
        starts: AtomicUsize::new(0),
    };
    let job = Arc::new(Job {
        hooks,
        ..Job::default()
    });
    let owned = OwnedProcess::launch(
        Command::new(program),
        prepared,
        deadline(),
        Arc::clone(&job),
    );
    let limit = deadline();
    while !gate.entered.load(Ordering::Acquire) {
        assert!(Instant::now() < limit);
        std::thread::sleep(Duration::from_millis(1));
    }
    let error = owned
        .wait_ready(Instant::now(), &CancellationToken::new())
        .unwrap_err();
    assert!(matches!(error.cause(), ChildCause::Deadline));
    assert!(
        owned
            .cleanup(Instant::now())
            .unwrap_err()
            .cleanup_faults()
            .contains(&ChildCleanup::PendingStart)
    );
    assert_eq!(job.hooks.starts.load(Ordering::SeqCst), 1);
    gate.released.store(true, Ordering::Release);
    owned.cleanup(deadline()).unwrap_or_else(|error| {
        let state=job.state.lock().unwrap();panic!("{error:?}; ready={}, started={}, attempted={}, status={:?}, opaque={}, failed={}, identity={}, faults={:?}",job.ready.load(Ordering::Acquire),state.started,state.attempted,state.status,state.opaque,state.failed,state.identity.is_some(),state.faults)
    });
    assert_eq!(job.hooks.starts.load(Ordering::SeqCst), 1);
    assert_eq!(owned.status().unwrap(), Some(137));
}
