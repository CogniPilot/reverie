//! Actual owned Runtime/Nix/engine clients. Rootless profile/sub-ID observations
//! are controlled here; their native policy owner has its separate tests.
use super::super::image::{NixImageQualification as Q, Observations};
use super::*;
use reverie_contracts::{
    rootless::{RootlessConfig, RootlessImage},
    worker_config,
};
use std::cell::RefCell;

#[derive(Default)]
struct Observed {
    events: RefCell<Vec<&'static str>>,
    refuse_image: bool,
}
impl Observations for Observed {
    fn enabled(&self, config: &RootlessConfig) -> Result<bool> {
        self.events.borrow_mut().push("enabled");
        Ok(config.enabled())
    }
    fn image(&self, config: &RootlessConfig, image: &RootlessImage) -> Result<()> {
        self.events.borrow_mut().push("image");
        config
            .image_identity(image)
            .map_err(crate::rootless::RootlessHostError::from)?;
        need(!self.refuse_image, NixFault::EngineFailed)
    }
}
fn source(tree: &Tree, enabled: bool) -> EffectiveWorkerConfig {
    let mut raw: serde_json::Value =
        serde_json::from_slice(&worker_config::encode_config(&tree.source('a'))).unwrap();
    raw["rootlessDocker"] = json!({"enabled":enabled,"seccompProfile":"/nix/store/fixture-rootless-profile","seccompSha256":"a".repeat(64)});
    worker_config::decode(&serde_json::to_vec(&raw).unwrap()).unwrap()
}
fn retain(tree: &Tree, runtime: &WorkerRuntime, enabled: bool) -> NixWorkflow {
    let source = source(tree, enabled);
    let sid = ProfileSessionId::parse(SID).unwrap();
    let mut storage = runtime
        .resolve_storage(&source, &sid)
        .unwrap()
        .into_legacy()
        .unwrap();
    storage.prepare_storage().unwrap();
    let guard = NixStoreGuard::acquire_launch(&source, &sid).unwrap();
    runtime
        .retain_nix_store(guard, storage, source)
        .unwrap_or_else(|_| panic!("actual resource record"))
}
fn image(tree: &Tree) {
    let uid = native::uid();
    fs::write(tree.root.join("rootless-image.out"), serde_json::to_vec(&json!([{"Id":format!("sha256:{}","a".repeat(64)),"Config":{"User":format!("{uid}:{uid}"),"Labels":{"org.reverie.worker.rootless-docker":"1","org.reverie.worker.uid":uid.to_string(),"org.reverie.worker.gid":uid.to_string(),"org.reverie.worker.rootless-docker.mount-layout":"1","reverie.worker.nix-store":"0"}}}])).unwrap()).unwrap();
}
fn qualify(runtime: &WorkerRuntime, workflow: &NixWorkflow, observed: &Observed) -> Q {
    runtime
        .nix_workflows()
        .qualify_image(runtime, workflow, end(), observed)
        .unwrap()
}
#[test]
fn absent_phase_has_no_new_engine_or_native_profile_dependency_and_is_one_shot() {
    let tree = Tree::new();
    let runtime = tree.runtime("success", Hooks::default());
    let workflow = retain(&tree, &runtime, false);
    assert_eq!(
        runtime
            .qualify_prepared_nix_image(&workflow, end())
            .unwrap(),
        Q::NotRequired
    );
    assert!(tree.trace().is_empty());
    assert!(
        runtime
            .qualify_prepared_nix_image(&workflow, end())
            .is_err()
    );
    assert_eq!(
        runtime.run_nix_store(&workflow).unwrap(),
        NixProgress::Prepared
    );
    let (guard, storage, result) = returned(&runtime, workflow);
    result.unwrap();
    close_resources(guard, storage);
    runtime.close(end()).unwrap();
}
#[test]
fn enabled_observations_precede_and_follow_exact_image_before_same_record_nix() {
    let tree = Tree::new();
    image(&tree);
    let runtime = tree.runtime("rootless-image", Hooks::default());
    let workflow = retain(&tree, &runtime, true);
    let other = tree.runtime("rootless-image", Hooks::default());
    assert!(other.qualify_prepared_nix_image(&workflow, end()).is_err());
    assert!(runtime.run_nix_store(&workflow).is_err());
    assert!(tree.trace().is_empty());
    let observed = Observed::default();
    assert_eq!(qualify(&runtime, &workflow, &observed), Q::Confirmed);
    assert_eq!(*observed.events.borrow(), ["enabled", "image"]);
    assert_eq!(
        tree.trace(),
        [vec![
            "image".to_owned(),
            "inspect".to_owned(),
            format!("sha256:{}", "a".repeat(64))
        ]]
    );
    assert!(
        runtime
            .qualify_prepared_nix_image(&workflow, end())
            .is_err()
    );
    assert_eq!(
        runtime.run_nix_store(&workflow).unwrap(),
        NixProgress::NoHelper
    );
    assert_eq!(count(&tree, "image"), 2);
    let (guard, storage, result) = returned(&runtime, workflow);
    assert_eq!(result.unwrap(), NixDisposition::NoHelper);
    close_resources(guard, storage);
    runtime.close(end()).unwrap();
    other.close(end()).unwrap();
}
#[test]
fn foreign_image_envelope_and_policy_refusal_prevent_preparation_without_replay() {
    for body in [
        b"[]".as_slice(),
        br#"[{"Id":"wrong"}]"#,
        b"\xff",
        br#"[{"Id":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}]"#,
    ] {
        let tree = Tree::new();
        fs::write(tree.root.join("rootless-image.out"), body).unwrap();
        let runtime = tree.runtime("rootless-image", Hooks::default());
        let workflow = retain(&tree, &runtime, true);
        assert_eq!(
            qualify(&runtime, &workflow, &Observed::default()),
            Q::Rejected
        );
        assert!(runtime.run_nix_store(&workflow).is_err());
        assert!(
            runtime
                .qualify_prepared_nix_image(&workflow, end())
                .is_err()
        );
        assert_eq!(count(&tree, "image"), 1);
        let (guard, storage, result) = returned(&runtime, workflow);
        assert!(result.is_err());
        close_resources(guard, storage);
        runtime.close(end()).unwrap();
    }
}
#[test]
fn actual_nix_lock_rebinding_fences_enabled_phase_but_disabled_branch_does_not_read_it() {
    for enabled in [false, true] {
        let tree = Tree::new();
        let runtime = tree.runtime("success", Hooks::default());
        let workflow = retain(&tree, &runtime, enabled);
        let lock = tree.root.join("state").join(SID).join("nix.lock");
        let original = lock.with_extension("original");
        fs::rename(&lock, &original).unwrap();
        fs::write(&lock, b"foreign lock remains unchanged").unwrap();
        let observed = Observed::default();
        assert_eq!(
            qualify(&runtime, &workflow, &observed),
            if enabled { Q::Rejected } else { Q::NotRequired }
        );
        assert_eq!(*observed.events.borrow(), ["enabled"]);
        assert!(tree.trace().is_empty());
        assert_eq!(fs::read(&lock).unwrap(), b"foreign lock remains unchanged");
        // Restore only this test's owned original for fixture finalization.
        fs::remove_file(&lock).unwrap();
        fs::rename(&original, &lock).unwrap();
        if !enabled {
            assert_eq!(
                runtime.run_nix_store(&workflow).unwrap(),
                NixProgress::Prepared
            );
        }
        let (guard, storage, result) = returned(&runtime, workflow);
        assert_eq!(result.is_ok(), !enabled);
        close_resources(guard, storage);
        runtime.close(end()).unwrap();
    }
}
#[test]
fn real_nonzero_client_and_late_host_refusal_keep_actual_owners_negative() {
    for mode in ["rootless-image", "rootless-image-nonzero"] {
        let tree = Tree::new();
        image(&tree);
        let runtime = tree.runtime(mode, Hooks::default());
        let workflow = retain(&tree, &runtime, true);
        let observed = Observed {
            refuse_image: true,
            ..Observed::default()
        };
        assert_eq!(qualify(&runtime, &workflow, &observed), Q::Rejected);
        assert_eq!(
            observed.events.borrow().len(),
            if mode == "rootless-image" { 2 } else { 1 }
        );
        assert_eq!(count(&tree, "image"), 1);
        assert!(runtime.run_nix_store(&workflow).is_err());
        let (guard, storage, result) = returned(&runtime, workflow);
        assert!(result.is_err());
        close_resources(guard, storage);
        runtime.close(end()).unwrap();
    }
}
#[test]
fn expired_deadline_or_cancel_consumes_phase_without_a_new_constructor() {
    for cancelled in [false, true] {
        let tree = Tree::new();
        let runtime = tree.runtime("rootless-image", Hooks::default());
        let workflow = retain(&tree, &runtime, true);
        let deadline = if cancelled {
            runtime.request_stop();
            end()
        } else {
            Instant::now()
        };
        let observed = Observed::default();
        assert_eq!(
            runtime
                .nix_workflows()
                .qualify_image(&runtime, &workflow, deadline, &observed)
                .unwrap(),
            Q::Rejected
        );
        assert!(observed.events.borrow().is_empty());
        assert!(tree.trace().is_empty());
        assert!(runtime.run_nix_store(&workflow).is_err());
        let (guard, storage, result) = returned(&runtime, workflow);
        assert!(result.is_err());
        close_resources(guard, storage);
        runtime.close(end()).unwrap();
    }
}
#[test]
fn delayed_actual_constructor_remains_owned_then_settlement_cannot_qualify_it() {
    use crate::captured_client::test_hooks::Gate;
    let tree = Tree::new();
    image(&tree);
    let gate = Arc::new(Gate::default());
    let runtime = tree.runtime(
        "rootless-image",
        Hooks {
            gate: Some(gate.clone()),
            ..Hooks::default()
        },
    );
    let workflow = retain(&tree, &runtime, true);
    struct Release(Arc<Gate>);
    impl Drop for Release {
        fn drop(&mut self) {
            self.0.released.store(true, Ordering::Release);
        }
    }
    let _release = Release(gate.clone());
    let result = std::thread::scope(|scope| {
        let runtime = &runtime;
        let workflow = &workflow;
        let task = scope.spawn(move || {
            runtime.nix_workflows().qualify_image(
                runtime,
                workflow,
                Instant::now() + Duration::from_secs(5),
                &Observed::default(),
            )
        });
        let setup = end();
        while !gate.entered.load(Ordering::Acquire) {
            assert!(
                Instant::now() < setup,
                "actual constructor admitted before original deadline"
            );
            std::thread::sleep(Duration::from_millis(1));
        }
        task.join().unwrap()
    });
    gate.released.store(true, Ordering::Release);
    assert!(gate.entered.load(Ordering::Acquire));
    assert_eq!(result.unwrap(), Q::Retained);
    assert!(runtime.reclaim_nix_store(workflow.clone()).is_err());
    runtime.settle_owned(end()).unwrap();
    assert!(runtime.run_nix_store(&workflow).is_err());
    assert!(
        runtime
            .qualify_prepared_nix_image(&workflow, end())
            .is_err()
    );
    assert!(count(&tree, "image") <= 1);
    let (guard, storage, result) = returned(&runtime, workflow);
    assert!(result.is_err());
    close_resources(guard, storage);
    runtime.close(end()).unwrap();
}
