use super::*;
use crate::captured_client::{
    CallFailure, CancellationToken, CapturedOutput, Policy, test_hooks::Gate,
};

type MetadataTask = std::thread::JoinHandle<std::result::Result<CapturedOutput, CallFailure>>;
struct Contention<'a> {
    tree: &'a Tree,
    gate: Arc<Gate>,
    workflow: Option<std::thread::JoinHandle<Result<NixProgress>>>,
    metadata: Option<MetadataTask>,
}
impl<'a> Contention<'a> {
    fn new(tree: &'a Tree, runtime: &Arc<WorkerRuntime>, workflow: &NixWorkflow) -> Self {
        let gate = Arc::new(Gate::default());
        workflow.record.lock().unwrap().before_remove = Some(gate.clone());
        let alias = workflow.clone();
        let worker = runtime.clone();
        let workflow = std::thread::spawn(move || worker.run_nix_store(&alias));
        let mut owner = Self {
            tree,
            gate,
            workflow: Some(workflow),
            metadata: None,
        };
        let until = end();
        while !owner.gate.entered.load(Ordering::Acquire) {
            assert!(Instant::now() < until);
            std::thread::sleep(Duration::from_millis(1));
        }
        let worker = runtime.clone();
        owner.metadata = Some(std::thread::spawn(move || {
            worker.installed_engine().engine.client.run_scoped(
                ["ps", "-aq", "--no-trunc"].map(Into::into).to_vec(),
                Instant::now() + Duration::from_secs(60),
                &CancellationToken::new(),
                Policy {
                    maximum: Duration::from_secs(60),
                    maximum_output: 4 * 1024 * 1024,
                    successful_exit: true,
                },
            )
        }));
        tree.wait("metadata-entered");
        owner.gate.released.store(true, Ordering::Release);
        owner
    }
    fn release_metadata(&mut self) {
        fs::write(self.tree.root.join("release-metadata"), b"owned").unwrap();
        assert!(self.metadata.take().unwrap().join().unwrap().is_ok());
    }
    fn finish(&mut self) -> NixProgress {
        self.workflow.take().unwrap().join().unwrap().unwrap()
    }
}
impl Drop for Contention<'_> {
    fn drop(&mut self) {
        self.gate.released.store(true, Ordering::Release);
        let _ = fs::write(self.tree.root.join("release-metadata"), b"owned");
        if let Some(task) = self.metadata.take() {
            let _ = task.join();
        }
        if let Some(task) = self.workflow.take() {
            let _ = task.join();
        }
    }
}

#[test]
fn busy_before_removal_waits_for_first_real_admission_without_cancelling_other_metadata() {
    let tree = Tree::new();
    let runtime = Arc::new(tree.runtime("success", Hooks::default()));
    let workflow = tree.retain(&runtime, 'a');
    let mut contention = Contention::new(&tree, &runtime, &workflow);
    std::thread::sleep(Duration::from_millis(80));
    assert_eq!(count(&tree, "rm"), 0);
    assert!(tree.root.join("created").exists());
    contention.release_metadata();
    assert_eq!(contention.finish(), NixProgress::Prepared);
    assert_eq!(count(&tree, "rm"), 1);
    assert_eq!(count(&tree, "ps"), 1);
    assert!(tree.root.join("metadata-finished").exists());
    let (guard, storage, result) = returned(&runtime, workflow);
    assert_eq!(result.unwrap(), NixDisposition::Prepared);
    close_resources(guard, storage);
    runtime.close(end()).unwrap();
}

#[test]
fn original_cleanup_deadline_expires_before_admission_with_zero_removals_and_retained_owners() {
    let tree = Tree::new();
    let runtime = Arc::new(tree.runtime("success", Hooks::default()));
    let workflow = tree.retain(&runtime, 'a');
    let mut contention = Contention::new(&tree, &runtime, &workflow);
    let start = Instant::now();
    assert_eq!(contention.finish(), NixProgress::Retained);
    assert!(start.elapsed() >= Duration::from_secs(19));
    assert_eq!(count(&tree, "rm"), 0);
    assert!(tree.root.join("created").exists());
    contention.release_metadata();
    assert!(runtime.reclaim_nix_store(workflow.clone()).is_err());
    assert!(runtime.close(end()).is_err());
    assert!(runtime.close(end()).is_err());
    assert_eq!(count(&tree, "rm"), 0);
    assert!(NixStoreGuard::acquire_migration(&tree.source('a'), workflow.session()).is_err());
}
