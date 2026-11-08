//! Actual owned private files only. Nonexistent immutable references remain
//! DATA: these controls do not qualify a website, engine, program or owner.
use super::*;
use serde_json::{Value, json};
use std::{
    fs,
    os::unix::fs::{MetadataExt, PermissionsExt},
    path::PathBuf,
    sync::atomic::{AtomicUsize, Ordering},
    time::Duration,
};
static NEXT: AtomicUsize = AtomicUsize::new(0);
struct Tree {
    path: PathBuf,
    config: EffectiveWorkerConfig,
    raw: Vec<u8>,
}
impl Tree {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "resource-facts-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        let gid = fs::metadata(&path).unwrap().gid();
        let config = json!({"uid":native::uid(),"gid":gid,"stateRoot":path.join("workers"),
            "resourceReservations":{"directory":path},"resourceActorConfig":path.join("resource-actor.json")});
        let config =
            reverie_contracts::worker_config::decode(&serde_json::to_vec(&config).unwrap())
                .unwrap();
        let selected = ResourceActorSettings::capture(&config).unwrap();
        let raw =
            serde_json::to_vec(&document(selected.domain().as_str(), native::uid(), gid)).unwrap();
        let tree = Self { path, config, raw };
        tree.write();
        tree
    }
    fn file(&self) -> PathBuf {
        self.path.join("resource-actor.json")
    }
    fn write(&self) {
        fs::write(self.file(), &self.raw).unwrap();
        fs::set_permissions(self.file(), fs::Permissions::from_mode(0o600)).unwrap();
    }
}
impl Drop for Tree {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.path).unwrap();
    }
}
fn document(domain: &str, uid: u32, gid: u32) -> Value {
    let sha = "a".repeat(64);
    let program = "/nix/store/synthetic/bin/program";
    json!({"version":2,"purpose":"resource-replacement-v1","configurationDigest":domain,
        "engine":{"socket":"/run/synthetic.sock","identity":[1,2,uid,gid],"id":"synthetic"},
        "imageProvenance":{"path":"/nix/store/synthetic/provenance.json","sha256":sha},
        "client":{"path":"/nix/store/synthetic/client.json","sha256":sha},
        "website":{"containerId":"b".repeat(64),"imageId":format!("sha256:{}","c".repeat(64)),
            "configDigest":sha,"hostConfigDigest":sha,"mountsDigest":sha,"initPid":null,"initStart":null,
            "uid":uid,"gid":gid,"bootstrap":{"executable":program,"argv":[program]},
            "node":{"executable":program,"argv":[program,"entry"]},
            "codeFiles":{program:{"sha256":sha,"bytes":1}}}})
}
fn end() -> Instant {
    Instant::now() + Duration::from_secs(5)
}
#[test]
fn actual_private_facts_are_existing_only_and_policy_changes_preserve_the_installed_generation() {
    let tree = Tree::new();
    let mut observer = InstalledFactsObserver::default();
    let selected = observer.observe(&tree.config, end()).unwrap();
    assert_eq!(selected.engine.id, "synthetic");
    let mut changed: Value = serde_json::from_slice(
        &reverie_contracts::worker_config::encode_config(&tree.config),
    )
    .unwrap();
    changed["memoryMiB"] = json!(49152);
    changed["employeeMemoryPolicies"] = json!({"employee":{"memoryHighMiB":4096,"swapMiB":0}});
    let changed =
        reverie_contracts::worker_config::decode(&serde_json::to_vec(&changed).unwrap()).unwrap();
    observer.observe(&changed, end()).unwrap();
    let missing = tree.path.join("absent");
    fs::rename(tree.file(), &missing).unwrap();
    assert!(
        InstalledFactsObserver::default()
            .observe(&tree.config, end())
            .is_err()
    );
    assert!(
        !tree.file().exists(),
        "runtime observation must never provision facts"
    );
}
#[test]
fn actual_metadata_only_final_bracket_refuses_pending_replacement_and_process_gid_mismatch() {
    let tree = Tree::new();
    let mut observer = InstalledFactsObserver::default();
    assert!(observer.assert_metadata(&tree.config, end()).is_err());
    observer.observe(&tree.config, end()).unwrap();
    observer.assert_metadata(&tree.config, end()).unwrap();
    let pending = tree.path.join("resource-actor.installing.json");
    fs::write(&pending, b"{}").unwrap();
    assert_eq!(
        observer
            .assert_metadata(&tree.config, end())
            .unwrap_err()
            .code(),
        "RESOURCE_INSTALL_PENDING_REQUIRES_INSPECTION"
    );
    fs::remove_file(pending).unwrap();
    let old = tree.path.join("old-facts.json");
    fs::rename(tree.file(), old).unwrap();
    tree.write();
    assert!(observer.assert_metadata(&tree.config, end()).is_err());
    let mut changed: Value = serde_json::from_slice(
        &reverie_contracts::worker_config::encode_config(&tree.config),
    )
    .unwrap();
    changed["gid"] = json!(u64::from(nix::unistd::getgid().as_raw()) + 1);
    let changed =
        reverie_contracts::worker_config::decode(&serde_json::to_vec(&changed).unwrap()).unwrap();
    assert_eq!(
        InstalledFactsObserver::default()
            .observe(&changed, end())
            .err()
            .unwrap()
            .code(),
        "ORDINARY_OWNER_WEBSITE_REQUIRED"
    );
}
#[test]
fn actual_installing_marker_symlink_hardlink_and_nonexact_mode_refuse() {
    let tree = Tree::new();
    let pending = tree.path.join("resource-actor.installing.json");
    fs::write(&pending, b"{}").unwrap();
    fs::set_permissions(&pending, fs::Permissions::from_mode(0o600)).unwrap();
    assert_eq!(
        InstalledFactsObserver::default()
            .observe(&tree.config, end())
            .err()
            .unwrap()
            .code(),
        "RESOURCE_INSTALL_PENDING_REQUIRES_INSPECTION"
    );
    fs::remove_file(pending).unwrap();
    let saved = tree.path.join("saved");
    fs::rename(tree.file(), &saved).unwrap();
    std::os::unix::fs::symlink("saved", tree.file()).unwrap();
    assert!(
        InstalledFactsObserver::default()
            .observe(&tree.config, end())
            .is_err()
    );
    fs::remove_file(tree.file()).unwrap();
    fs::hard_link(&saved, tree.file()).unwrap();
    assert!(
        InstalledFactsObserver::default()
            .observe(&tree.config, end())
            .is_err()
    );
    fs::remove_file(tree.file()).unwrap();
    fs::rename(saved, tree.file()).unwrap();
    for mode in [0o400, 0o640, 0o1600] {
        fs::set_permissions(tree.file(), fs::Permissions::from_mode(mode)).unwrap();
        assert!(
            InstalledFactsObserver::default()
                .observe(&tree.config, end())
                .is_err()
        );
    }
}
#[test]
fn actual_replaced_parent_or_inplace_document_generation_cannot_rebase_original_observer() {
    let tree = Tree::new();
    let mut original = InstalledFactsObserver::default();
    original.observe(&tree.config, end()).unwrap();
    let mut bytes = tree.raw.clone();
    bytes.push(b' ');
    fs::write(tree.file(), bytes).unwrap();
    assert_eq!(
        original.observe(&tree.config, end()).err().unwrap().code(),
        "RESOURCE_INSTALL_CHANGED"
    );
    tree.write();
    let mut parent_bound = InstalledFactsObserver::default();
    parent_bound.observe(&tree.config, end()).unwrap();
    let saved = tree.path.with_extension("saved");
    fs::rename(&tree.path, &saved).unwrap();
    fs::create_dir(&tree.path).unwrap();
    fs::set_permissions(&tree.path, fs::Permissions::from_mode(0o700)).unwrap();
    fs::rename(saved.join("resource-actor.json"), tree.file()).unwrap();
    fs::remove_dir(saved).unwrap();
    assert_eq!(
        parent_bound
            .observe(&tree.config, end())
            .err()
            .unwrap()
            .code(),
        "RESOURCE_INSTALL_CHANGED"
    );
}
#[test]
fn actual_consumed_close_failure_stays_negative_after_every_owned_descriptor_is_consumed() {
    let tree = Tree::new();
    let mut observer = InstalledFactsObserver::default();
    native::test_faults::set(None, true);
    let first = observer.observe(&tree.config, end());
    native::test_faults::set(None, false);
    assert!(first.is_err());
    assert_eq!(
        observer.observe(&tree.config, end()).err().unwrap().code(),
        "RESOURCE_INSTALL_CLOSE_UNCONFIRMED"
    );
    let retained = fs::read_dir("/proc/self/fd")
        .unwrap()
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| fs::read_link(entry.path()).ok())
        .any(|path| path.starts_with(&tree.path));
    assert!(
        !retained,
        "all retained file descriptors must be consumed once"
    );
}
