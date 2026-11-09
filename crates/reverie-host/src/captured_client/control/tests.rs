use super::*;
mod admission;
use crate::captured_client::test_hooks::{Gate, Hooks};
use std::{collections::BTreeMap, fs, path::PathBuf, sync::atomic::AtomicUsize};
static NEXT: AtomicUsize = AtomicUsize::new(0);
struct Tree(PathBuf);
impl Tree {
    fn new() -> Self {
        let program = crate::engine_metadata::tests::program();
        let path = std::env::temp_dir().join(format!(
            "result-handoff-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::AcqRel)
        ));
        fs::create_dir(&path).unwrap();
        fs::hard_link(program, path.join("argv")).unwrap();
        fs::hard_link(path.join("argv"), path.join("failure")).unwrap();
        Self(path)
    }
    fn client(&self, hooks: Hooks) -> Arc<CapturedClient> {
        self.client_mode("argv", hooks)
    }
    fn client_mode(&self, mode: &str, hooks: Hooks) -> Arc<CapturedClient> {
        let mut command = InstalledCommand::from_service(
            self.0.join(mode).as_os_str(),
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
fn wait(flag: &AtomicBool) {
    let until = end();
    while !flag.load(Ordering::Acquire) && Instant::now() < until {
        std::thread::sleep(Duration::from_millis(1));
    }
    assert!(
        flag.load(Ordering::Acquire),
        "actual owned handoff stage reached"
    );
}
struct Running {
    thread: Option<
        std::thread::JoinHandle<std::result::Result<CapturedOutput, super::super::CallFailure>>,
    >,
    gate: Arc<Gate>,
    deadline: Instant,
}
impl Running {
    fn new(client: Arc<CapturedClient>, gate: Arc<Gate>) -> Self {
        let deadline = Instant::now() + Duration::from_secs(20);
        let thread = std::thread::spawn(move || {
            client.run_scoped(
                vec!["one-owned-query".into()],
                deadline,
                &CancellationToken::new(),
                Policy {
                    maximum: Duration::from_secs(20),
                    maximum_output: 4096,
                    successful_exit: true,
                },
            )
        });
        Self {
            thread: Some(thread),
            gate,
            deadline,
        }
    }
    fn finish(&mut self) -> std::result::Result<CapturedOutput, super::super::CallFailure> {
        self.thread.take().unwrap().join().unwrap()
    }
}

#[test]
fn actual_completed_nonzero_status_survives_contended_handoff_without_replay() {
    let tree = Tree::new();
    let gate = Arc::new(Gate::default());
    let hooks = Hooks {
        result_gate: Some(gate.clone()),
        ..Hooks::default()
    };
    let contended = hooks.handoff_contended.clone();
    let starts = hooks.starts.clone();
    let client = tree.client_mode("failure", hooks);
    let mut running = Running::new(client.clone(), gate.clone());
    wait(&gate.entered);
    let active = client.active.lock().unwrap();
    gate.released.store(true, Ordering::Release);
    wait(&contended);
    drop(active);
    let failure = running.finish().err().unwrap();
    assert_eq!(failure.error.fault, EngineFault::Exit);
    assert!(!failure.error.is_uncertain());
    assert_eq!(starts.load(Ordering::Acquire), 1);
    client.close(end()).unwrap();
}

#[test]
fn actual_handoff_expiry_retains_original_completed_result_and_exact_job() {
    let tree = Tree::new();
    let gate = Arc::new(Gate::default());
    let hooks = Hooks {
        result_gate: Some(gate.clone()),
        ..Hooks::default()
    };
    let contended = hooks.handoff_contended.clone();
    let starts = hooks.starts.clone();
    let client = tree.client(hooks);
    let mut running = Running::new(client.clone(), gate.clone());
    wait(&gate.entered);
    let active = client.active.lock().unwrap();
    let actual = active.as_ref().unwrap().query().clone();
    gate.released.store(true, Ordering::Release);
    wait(&contended);
    // Hold the real handoff through its ORIGINAL 20s operation ceiling;
    // setup was synchronized after actual child completion, not time guessed.
    let failure = running.finish().err().unwrap();
    assert!(Instant::now() >= running.deadline);
    assert_eq!(failure.error.fault, EngineFault::Deadline);
    assert!(failure.error.is_uncertain());
    let call = failure.call.unwrap();
    assert!(Arc::ptr_eq(&call.job, &actual));
    let data = actual.data.lock().unwrap();
    assert_eq!(
        data.result.as_ref().unwrap().as_ref().unwrap().stdout,
        b"one-owned-query"
    );
    assert!(!data.process.has_pending_native_work());
    drop(data);
    drop(active);
    assert_eq!(starts.load(Ordering::Acquire), 1);
    client.settle_call(&call, end()).unwrap();
    assert!(client.active.lock().unwrap().is_none());
    client.close(end()).unwrap();
}

#[test]
fn poisoned_actual_handoff_retains_original_result_and_does_not_acknowledge_close() {
    let tree = Tree::new();
    let gate = Arc::new(Gate::default());
    let hooks = Hooks {
        result_gate: Some(gate.clone()),
        ..Hooks::default()
    };
    let starts = hooks.starts.clone();
    let client = tree.client(hooks);
    let mut running = Running::new(client.clone(), gate.clone());
    wait(&gate.entered);
    let actual = client
        .active
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .query()
        .clone();
    let sibling = client.clone();
    assert!(
        std::thread::spawn(move || {
            let _active = sibling.active.lock().unwrap();
            panic!("owned mutex poison control after real native completion");
        })
        .join()
        .is_err()
    );
    gate.released.store(true, Ordering::Release);
    let failure = running.finish().err().unwrap();
    assert_eq!(failure.error.fault, EngineFault::Supervisor);
    assert!(failure.error.is_uncertain());
    assert!(Arc::ptr_eq(&failure.call.unwrap().job, &actual));
    assert!(actual.data.lock().unwrap().result.as_ref().unwrap().is_ok());
    assert_eq!(starts.load(Ordering::Acquire), 1);
    assert!(client.close(end()).is_err());
}
impl Drop for Running {
    fn drop(&mut self) {
        self.gate.released.store(true, Ordering::Release);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}
#[test]
fn actual_completed_result_survives_exact_admission_mutex_handoff() {
    let tree = Tree::new();
    let gate = Arc::new(Gate::default());
    let hooks = Hooks {
        result_gate: Some(gate.clone()),
        ..Hooks::default()
    };
    let contended = hooks.handoff_contended.clone();
    let starts = hooks.starts.clone();
    let client = tree.client(hooks);
    let mut running = Running::new(client.clone(), gate.clone());
    wait(&gate.entered);
    // The child has actually completed and all native finalizers have run.
    // Hold the SAME mutex used by a sibling's pre-admission Busy check.
    let active = client.active.lock().unwrap();
    assert!(
        active
            .as_ref()
            .unwrap()
            .query()
            .finished
            .load(Ordering::Acquire)
    );
    gate.released.store(true, Ordering::Release);
    wait(&contended);
    drop(active);
    let outcome = running.finish();
    let observed = outcome.as_ref().err().map(|failure| &failure.error);
    assert!(
        outcome.is_ok(),
        "known completed result lost to mutex handoff: {observed:?}"
    );
    assert_eq!(
        outcome.unwrap_or_else(|_| unreachable!()).stdout,
        b"one-owned-query"
    );
    assert_eq!(starts.load(Ordering::Acquire), 1, "no native query replay");
    client.close(end()).unwrap();
}
