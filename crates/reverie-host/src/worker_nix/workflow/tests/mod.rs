use super::*;
use crate::{captured_client::test_hooks::Hooks, engine_metadata::EngineBootstrap};
use reverie_core::{
    resources::{BudgetMode, CpuQuota, ResourcePolicy},
    worker_schema::{WorkerBase, WorkerIds},
};
use serde_json::json;
use std::{
    collections::BTreeMap, fs, os::unix::fs::PermissionsExt, path::Path, process::Command,
    sync::OnceLock,
};
mod admission;
mod employee;
mod global_stop;
mod image;
mod retained;
static PROGRAM: OnceLock<PathBuf> = OnceLock::new();
static NEXT: AtomicU64 = AtomicU64::new(0);
const SID: &str = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
fn program() -> &'static Path {
    PROGRAM.get_or_init(|| {
        let root = std::env::temp_dir().join(format!("nix-workflow-build-{}", std::process::id()));
        fs::create_dir(&root).unwrap();
        let source = root.join("child.rs");
        fs::write(
            &source,
            include_str!("../../../../tests/support/nix_workflow_child.rs"),
        )
        .unwrap();
        let binary = root.join("engine");
        assert!(
            Command::new("rustc")
                .args(["--edition=2024", "-o"])
                .arg(&binary)
                .arg(&source)
                .status()
                .unwrap()
                .success()
        );
        binary
    })
}
struct Tree {
    root: PathBuf,
}
impl Tree {
    fn new() -> Self {
        let _ = program();
        let root = fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(format!(
                "nix-workflow-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::AcqRel)
            ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        fs::write(root.join("company.json"), b"{\"employees\":[]}").unwrap();
        fs::set_permissions(root.join("company.json"), fs::Permissions::from_mode(0o600)).unwrap();
        Self { root }
    }
    fn source(&self, image: char) -> EffectiveWorkerConfig {
        let raw = json!({"uid":native::uid(),"gid":native::uid(),"deployment":"fixture","serverContainer":"fixture-server","maxWorkers":4,"budgetMode":"admission","memoryMiB":1024,"pidsLimit":128,"cpus":1,"poolMemoryMiB":8192,"poolTasksMax":512,"stateRoot":self.root.join("state"),"scratchRoot":self.root.join("scratch"),"companyFile":self.root.join("company.json"),"mounts":[],"image":format!("sha256:{}", image.to_string().repeat(64))});
        reverie_contracts::worker_config::decode(&serde_json::to_vec(&raw).unwrap()).unwrap()
    }
    fn runtime(&self, mode: &str, hooks: Hooks) -> WorkerRuntime {
        let base = WorkerBase::try_new(
            "fixture".into(),
            "fixture-server".into(),
            format!("sha256:{}", "a".repeat(64)),
            WorkerIds::try_new(native::uid(), native::uid()).unwrap(),
            4,
            ResourcePolicy::try_new(
                BudgetMode::Admission,
                1024,
                128,
                CpuQuota::from_integer(1).unwrap(),
                8192,
                512,
            )
            .unwrap(),
        )
        .unwrap();
        let mut bootstrap = EngineBootstrap::from_service(
            program().as_os_str(),
            BTreeMap::from([("NIX_FIXTURE_MODE".into(), mode.into())]),
            self.root.clone(),
        )
        .unwrap();
        bootstrap.hooks = hooks;
        WorkerRuntime::new(InstalledWorkerEngine::new(bootstrap), &base)
    }
    fn retain(&self, runtime: &WorkerRuntime, image: char) -> NixWorkflow {
        self.retain_session(runtime, image, SID)
    }
    fn retain_session(&self, runtime: &WorkerRuntime, image: char, session: &str) -> NixWorkflow {
        let source = self.source(image);
        let sid = ProfileSessionId::parse(session).unwrap();
        let mut storage = runtime
            .resolve_storage(&source, &sid)
            .unwrap()
            .into_legacy()
            .unwrap();
        storage.prepare_storage().unwrap();
        let guard = NixStoreGuard::acquire_launch(&source, &sid).unwrap();
        runtime
            .retain_nix_store(guard, storage, source)
            .unwrap_or_else(|_| panic!("real resource retention failed"))
    }
    fn trace(&self) -> Vec<Vec<String>> {
        fs::read_to_string(self.root.join("trace"))
            .unwrap_or_default()
            .lines()
            .map(|line| line.split('\0').map(str::to_owned).collect())
            .collect()
    }
    fn wait(&self, name: &str) {
        let end = Instant::now() + Duration::from_secs(5);
        while !self.root.join(name).exists() {
            assert!(Instant::now() < end, "fixture did not reach {name}");
            std::thread::sleep(Duration::from_millis(1));
        }
    }
}
impl Drop for Tree {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root).unwrap();
    }
}
fn end() -> Instant {
    Instant::now() + Duration::from_secs(3)
}
fn returned(
    runtime: &WorkerRuntime,
    workflow: NixWorkflow,
) -> (NixStoreGuard, LaunchStorage, Result<NixDisposition>) {
    runtime
        .reclaim_nix_store(workflow)
        .unwrap_or_else(|_| panic!("known result failed to return real resources"))
        .into_parts()
}
fn close_resources(guard: NixStoreGuard, storage: LaunchStorage) {
    guard.close().unwrap();
    storage.close(end()).unwrap();
}
fn count(tree: &Tree, command: &str) -> usize {
    tree.trace()
        .iter()
        .filter(|args| args[0] == command)
        .count()
}
fn normalize_argument(value: &str, pair: &str, root: &Path) -> String {
    if value == pair {
        "$UID:$UID".to_owned()
    } else {
        value.replace(root.to_str().unwrap(), "$ROOT")
    }
}

#[test]
fn actual_fixed_prepare_removes_its_helper_and_returns_the_same_resource_owners_once() {
    let tree = Tree::new();
    let runtime = tree.runtime("success", Hooks::default());
    let workflow = tree.retain(&runtime, 'a');
    let alias = workflow.clone();
    assert!(workflow.same_workflow(&alias));
    assert!(tree.trace().is_empty());
    assert_eq!(
        runtime.run_nix_store(&workflow).unwrap(),
        NixProgress::Prepared
    );
    assert!(runtime.run_nix_store(&workflow).is_err());
    assert!(tree.root.join("removed").exists());
    assert!(!tree.root.join("created").exists());
    assert_eq!(count(&tree, "create"), 1);
    assert_eq!(count(&tree, "start"), 1);
    assert_eq!(count(&tree, "logs"), 1);
    assert_eq!(count(&tree, "rm"), 1);
    let (guard, storage, result) = returned(&runtime, workflow);
    assert_eq!(result.unwrap(), NixDisposition::Prepared);
    assert!(runtime.reclaim_nix_store(alias).is_err());
    assert_eq!(
        fs::read(storage.paths().home().join(".reverie-nix-prepare.log")).unwrap(),
        b"owned-progress\nowned-diagnostic\n"
    );
    close_resources(guard, storage);
    runtime.close(end()).unwrap();
}

#[test]
fn started_inspection_loss_and_invalid_log_text_still_remove_once_and_return_negative_owners() {
    for mode in ["lost-inspection", "logs-failure", "helper-failed"] {
        let tree = Tree::new();
        let runtime = tree.runtime(mode, Hooks::default());
        let workflow = tree.retain(&runtime, 'a');
        assert_eq!(
            runtime.run_nix_store(&workflow).unwrap(),
            NixProgress::Rejected,
            "{mode}"
        );
        assert_eq!(count(&tree, "logs"), 1);
        assert_eq!(count(&tree, "rm"), 1);
        let (guard, storage, result) = returned(&runtime, workflow);
        assert!(result.is_err());
        close_resources(guard, storage);
        runtime.close(end()).unwrap();
    }
}

#[test]
fn genuine_legacy_rollback_retains_its_separate_selected_store_without_inventing_a_lease() {
    let tree = Tree::new();
    let runtime = tree.runtime("success", Hooks::default());
    let workflow = tree.retain(&runtime, 'a');
    let legacy = tree.root.join("scratch").join(SID).join("nix");
    fs::create_dir_all(&legacy).unwrap();
    fs::set_permissions(&legacy, fs::Permissions::from_mode(0o700)).unwrap();
    let marker = tree.root.join("state").join(SID).join("nix-rollback.json");
    fs::write(
        &marker,
        serde_json::to_vec(&json!({"version":1,"sessionId":SID,"legacy":true})).unwrap(),
    )
    .unwrap();
    fs::set_permissions(marker, fs::Permissions::from_mode(0o600)).unwrap();
    assert_eq!(
        runtime.run_nix_store(&workflow).unwrap(),
        NixProgress::Prepared
    );
    let create = tree
        .trace()
        .into_iter()
        .find(|args| args[0] == "create")
        .unwrap();
    assert!(create.contains(&format!(
        "type=bind,src={},dst=/target/nix",
        legacy.display()
    )));
    let (guard, storage, result) = returned(&runtime, workflow);
    assert_eq!(result.unwrap(), NixDisposition::Prepared);
    assert_eq!(
        storage.ownership_kind(),
        crate::worker_storage::StorageOwnershipKind::UnleasedLegacy
    );
    assert_ne!(storage.paths().nix(), legacy);
    assert_eq!(guard.selected_path().unwrap(), legacy);
    close_resources(guard, storage);
    runtime.close(end()).unwrap();
}

#[test]
fn stopped_prior_helper_must_match_scope_and_running_or_foreign_rows_never_remove_or_create() {
    for mode in ["prior-success", "prior-running", "prior-foreign"] {
        let tree = Tree::new();
        let runtime = tree.runtime(mode, Hooks::default());
        let workflow = tree.retain(&runtime, 'a');
        let progress = runtime.run_nix_store(&workflow).unwrap();
        if mode == "prior-success" {
            assert_eq!(progress, NixProgress::Prepared);
            assert_eq!(count(&tree, "rm"), 2);
        } else {
            assert_eq!(progress, NixProgress::Rejected);
            assert_eq!(count(&tree, "rm"), 0);
            assert_eq!(count(&tree, "create"), 0);
        }
        let (guard, storage, _) = returned(&runtime, workflow);
        close_resources(guard, storage);
        runtime.close(end()).unwrap();
    }
}

#[test]
fn diagnostic_hardlink_is_refused_before_truncation_and_helper_is_removed_once() {
    let tree = Tree::new();
    let runtime = tree.runtime("success", Hooks::default());
    let workflow = tree.retain(&runtime, 'a');
    let original = tree.root.join("owner-data");
    fs::write(&original, b"owner-should-survive").unwrap();
    let log = tree
        .root
        .join("state")
        .join(SID)
        .join("home/.reverie-nix-prepare.log");
    fs::hard_link(&original, &log).unwrap();
    assert_eq!(
        runtime.run_nix_store(&workflow).unwrap(),
        NixProgress::Rejected
    );
    assert_eq!(fs::read(&original).unwrap(), b"owner-should-survive");
    assert_eq!(fs::read(&log).unwrap(), b"owner-should-survive");
    assert_eq!(count(&tree, "rm"), 1);
    let (guard, storage, result) = returned(&runtime, workflow);
    assert!(result.is_err());
    close_resources(guard, storage);
    runtime.close(end()).unwrap();
}

#[test]
fn actual_unpatched_python_engine_transcripts_match_and_unknown_effects_keep_stronger_custody() {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("../../fixtures/legacy-engine-trace.json")).unwrap();
    for case in fixture["cases"].as_array().unwrap() {
        let mode = case["mode"].as_str().unwrap();
        let tree = Tree::new();
        let runtime = tree.runtime(mode, Hooks::default());
        let workflow = tree.retain(&runtime, if mode == "legacy" { 'b' } else { 'a' });
        let progress = runtime.run_nix_store(&workflow).unwrap();
        let expected = match case["native_result"].as_str().unwrap() {
            "no-helper" => NixProgress::NoHelper,
            "prepared" => NixProgress::Prepared,
            "rejected" => NixProgress::Rejected,
            "retained" => NixProgress::Retained,
            _ => panic!("fixture disposition"),
        };
        assert_eq!(progress, expected, "{mode}");
        let pair = format!("{}:{}", native::uid(), native::uid());
        let calls = tree
            .trace()
            .into_iter()
            .map(|args| {
                args.into_iter()
                    .map(|value| normalize_argument(&value, &pair, &tree.root))
                    .collect::<Vec<_>>()
            })
            .collect::<Vec<_>>();
        assert_eq!(
            serde_json::to_value(calls).unwrap(),
            case["calls"],
            "{mode}"
        );
        if progress == NixProgress::Retained {
            assert!(runtime.reclaim_nix_store(workflow).is_err());
            assert!(runtime.close(end()).is_err());
        } else {
            let (guard, storage, _) = returned(&runtime, workflow);
            close_resources(guard, storage);
            runtime.close(end()).unwrap();
        }
    }
}
