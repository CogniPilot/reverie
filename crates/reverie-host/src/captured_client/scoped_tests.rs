use super::*;
use std::{
    collections::BTreeMap,
    fs,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};
use test_hooks::{Gate, Hooks};
static NEXT: AtomicUsize = AtomicUsize::new(0);
#[test]
fn goal_stdout_only_uses_same_client_and_combined_mode_keeps_stderr_bound() {
    let tree = Tree::new();
    let program = tree.0.join("overflow");
    fs::hard_link(crate::engine_metadata::tests::program(), &program).unwrap();
    let client = CapturedClient::new(
        InstalledCommand::from_service(program.as_os_str(), BTreeMap::new(), tree.0.clone())
            .unwrap(),
    );
    let policy = Policy {
        maximum: Duration::from_secs(3),
        maximum_output: 64,
        successful_exit: true,
    };
    let output = client
        .run_goal_inventory(Vec::new(), end(), &CancellationToken::new(), policy)
        .unwrap_or_else(|failure| panic!("actual stdout-only call: {:?}", failure.error));
    assert!(output.stdout.is_empty() && output.stderr.is_empty() && output.succeeded);
    let failure = client
        .run_scoped(Vec::new(), end(), &CancellationToken::new(), policy)
        .err()
        .unwrap();
    assert_eq!(failure.error.fault, Fault::OutputBound);
    let call = failure
        .call
        .expect("failed admitted Combined query retains its original ticket");
    client.settle_call(&call, end()).unwrap();
    client.close(end()).unwrap();
}
struct Tree(PathBuf);
impl Tree {
    fn new() -> Self {
        let _ = crate::engine_metadata::tests::program();
        let path = std::env::temp_dir().join(format!(
            "scoped-capture-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::AcqRel)
        ));
        fs::create_dir(&path).unwrap();
        fs::hard_link(
            crate::engine_metadata::tests::program(),
            path.join("failure"),
        )
        .unwrap();
        Self(path)
    }
    fn client(&self, hooks: Hooks) -> Arc<CapturedClient> {
        let mut command = InstalledCommand::from_service(
            self.0.join("failure").as_os_str(),
            BTreeMap::new(),
            self.0.clone(),
        )
        .unwrap();
        command.hooks = hooks;
        Arc::new(CapturedClient::new(command))
    }
}
impl Drop for Tree {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}
fn end() -> Instant {
    Instant::now() + Duration::from_secs(3)
}
fn policy() -> Policy {
    Policy {
        maximum: Duration::from_secs(20),
        maximum_output: 4 * 1024 * 1024,
        successful_exit: true,
    }
}
fn run(
    client: &CapturedClient,
    deadline: Instant,
) -> std::result::Result<CapturedOutput, CallFailure> {
    run_with_cancellation(client, deadline, &CancellationToken::new())
}
fn run_with_cancellation(
    client: &CapturedClient,
    deadline: Instant,
    cancellation: &CancellationToken,
) -> std::result::Result<CapturedOutput, CallFailure> {
    client.run_scoped(
        vec!["fixed-owned-call".into()],
        deadline,
        cancellation,
        policy(),
    )
}
struct Running {
    client: Arc<CapturedClient>,
    gate: Arc<Gate>,
    cancellation: CancellationToken,
    thread: Option<std::thread::JoinHandle<std::result::Result<CapturedOutput, CallFailure>>>,
}
impl Running {
    fn new(client: Arc<CapturedClient>, gate: Arc<Gate>, deadline: Instant) -> Self {
        let worker = client.clone();
        let cancellation = CancellationToken::new();
        let token = cancellation.clone();
        let thread = std::thread::spawn(move || run_with_cancellation(&worker, deadline, &token));
        Self {
            client,
            gate,
            cancellation,
            thread: Some(thread),
        }
    }
    fn entered(&mut self) {
        let until = end();
        while !self.gate.entered.load(Ordering::Acquire) && Instant::now() < until {
            std::thread::sleep(Duration::from_millis(1));
        }
        let entered = self.gate.entered.load(Ordering::Acquire);
        let observed = if entered {
            None
        } else {
            self.gate.released.store(true, Ordering::Release);
            Some(
                self.thread
                    .take()
                    .unwrap()
                    .join()
                    .unwrap()
                    .err()
                    .map(|failure| (failure.error.fault, failure.call.is_some())),
            )
        };
        assert!(
            entered,
            "actual constructor hook not entered; joined worker result: {observed:?}"
        );
    }
    fn finish(&mut self) -> std::result::Result<CapturedOutput, CallFailure> {
        self.gate.released.store(true, Ordering::Release);
        self.thread.take().unwrap().join().unwrap()
    }
}
impl Drop for Running {
    fn drop(&mut self) {
        self.gate.released.store(true, Ordering::Release);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
        let _ = self.client.close(end());
    }
}

#[test]
fn busy_before_admission_has_no_call_and_never_cancels_the_admitted_job() {
    let tree = Tree::new();
    let gate = Arc::new(Gate::default());
    let hooks = Hooks {
        gate: Some(gate.clone()),
        ..Hooks::default()
    };
    let starts = hooks.starts.clone();
    let client = tree.client(hooks);
    let mut running = Running::new(client.clone(), gate, end());
    running.entered();
    let failure = run(&client, end()).err().unwrap();
    assert_eq!(failure.error.fault, Fault::Busy);
    assert!(failure.call.is_none());
    assert_eq!(starts.load(Ordering::Acquire), 1);
    let finished = running.finish().err().unwrap();
    assert_eq!(finished.error.fault, Fault::Exit);
    assert!(!finished.error.is_uncertain());
    client.close(end()).unwrap();
}

#[test]
fn completed_old_call_cannot_cancel_or_release_a_later_admitted_constructor() {
    let tree = Tree::new();
    let gate = Arc::new(Gate::default());
    gate.released.store(true, Ordering::Release);
    let hooks = Hooks {
        gate: Some(gate.clone()),
        ..Hooks::default()
    };
    let starts = hooks.starts.clone();
    let client = tree.client(hooks);
    let old = run(&client, end()).err().unwrap();
    assert_eq!(old.error.fault, Fault::Exit);
    let old = old.call.unwrap();
    gate.entered.store(false, Ordering::Release);
    gate.released.store(false, Ordering::Release);
    let mut running = Running::new(client.clone(), gate, end());
    running.entered();
    client.settle_call(&old, end()).unwrap();
    let busy = run(&client, end()).err().unwrap();
    assert_eq!(busy.error.fault, Fault::Busy);
    assert!(busy.call.is_none());
    assert_eq!(starts.load(Ordering::Acquire), 2);
    let other = tree.client(Hooks::default());
    assert_eq!(
        other.settle_call(&old, end()).unwrap_err().fault,
        Fault::Identity
    );
    let result = running.finish().err().unwrap();
    assert_eq!(result.error.fault, Fault::Exit);
    assert!(!result.error.is_uncertain());
    client.close(end()).unwrap();
    other.close(end()).unwrap();
}

#[test]
fn exact_uncertain_constructor_handle_retains_and_settles_the_late_child_without_replay() {
    let tree = Tree::new();
    let gate = Arc::new(Gate::default());
    let hooks = Hooks {
        gate: Some(gate.clone()),
        ..Hooks::default()
    };
    let starts = hooks.starts.clone();
    let client = tree.client(hooks);
    let mut running = Running::new(
        client.clone(),
        gate.clone(),
        Instant::now() + Duration::from_secs(20),
    );
    running.entered();
    running.cancellation.cancel();
    let failure = running
        .thread
        .take()
        .unwrap()
        .join()
        .unwrap()
        .err()
        .unwrap();
    assert!(failure.error.is_uncertain());
    let owned = failure.call.unwrap();
    assert!(client.settle_call(&owned, Instant::now()).is_err());
    assert_eq!(run(&client, end()).err().unwrap().error.fault, Fault::Busy);
    gate.released.store(true, Ordering::Release);
    client.settle_call(&owned, end()).unwrap();
    assert_eq!(starts.load(Ordering::Acquire), 1);
    client.close(end()).unwrap();
}

#[test]
fn global_close_seals_admission_while_the_same_actual_constructor_remains_retained() {
    let tree = Tree::new();
    let gate = Arc::new(Gate::default());
    let hooks = Hooks {
        gate: Some(gate.clone()),
        ..Hooks::default()
    };
    let starts = hooks.starts.clone();
    let client = tree.client(hooks);
    let mut running = Running::new(
        client.clone(),
        gate,
        Instant::now() + Duration::from_secs(20),
    );
    running.entered();
    assert!(client.close(Instant::now()).is_err());
    let busy = run(&client, end()).err().unwrap();
    assert!(busy.call.is_none());
    assert_eq!(busy.error.fault, Fault::Busy);
    let failure = running.finish().err().unwrap();
    assert!(failure.call.is_some());
    client.close(end()).unwrap();
    assert_eq!(starts.load(Ordering::Acquire), 1);
    assert!(run(&client, end()).err().unwrap().call.is_none());
}
#[test]
fn original_deadline_expires_while_actual_constructor_is_held_and_retains_the_exact_call() {
    let tree = Tree::new();
    let gate = Arc::new(Gate::default());
    let hooks = Hooks {
        gate: Some(gate.clone()),
        ..Hooks::default()
    };
    let starts = hooks.starts.clone();
    let client = tree.client(hooks);
    let mut running = Running::new(
        client.clone(),
        gate.clone(),
        Instant::now() + Duration::from_secs(20),
    );
    running.entered();
    // No cancellation: the captured original deadline must expire while the
    // actual constructor hook is still held. This is not fork/exec evidence.
    let failure = running
        .thread
        .take()
        .unwrap()
        .join()
        .unwrap()
        .err()
        .unwrap();
    assert_eq!(failure.error.fault, Fault::Deadline);
    assert!(failure.error.is_uncertain());
    assert!(!running.cancellation.is_cancelled());
    let owned = failure.call.unwrap();
    assert!(client.settle_call(&owned, Instant::now()).is_err());
    assert_eq!(run(&client, end()).err().unwrap().error.fault, Fault::Busy);
    gate.released.store(true, Ordering::Release);
    client.settle_call(&owned, end()).unwrap();
    assert_eq!(starts.load(Ordering::Acquire), 1);
    client.close(end()).unwrap();
}
