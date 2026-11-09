use super::*;
use std::os::unix::fs::{PermissionsExt, symlink};
struct Tree(PathBuf);
impl Tree {
    fn new() -> Self {
        Self(nix::unistd::mkdtemp(&std::env::temp_dir().join("owner-inventory-XXXXXX")).unwrap())
    }
    fn write(&self, name: &str, value: &[u8]) -> PathBuf {
        let path = self.0.join(name);
        fs::write(&path, value).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        path
    }
    fn setup(&self) -> (PathBuf, EffectiveWorkerConfig) {
        let raw = serde_json::to_vec(&serde_json::json!({"uid":native::policy_effective_uid(),
            "companyRoot":self.0,"companyFile":self.0.join("company.json")}))
        .unwrap();
        let source = self.write("broker.json", &raw);
        self.write("company.json", b"{\"employees\":[],\"retired\":[]}");
        (
            source,
            reverie_contracts::worker_config::decode(&raw).unwrap(),
        )
    }
    fn reader(&self, source: &Path, config: &EffectiveWorkerConfig) -> OwnerInventoryReader {
        OwnerInventoryReader::capture_at(
            &self.0,
            source,
            config,
            Instant::now() + std::time::Duration::from_secs(10),
        )
        .unwrap()
    }
}
impl Drop for Tree {
    fn drop(&mut self) {
        native::test_faults::set(None, false);
        fs::remove_dir_all(&self.0).unwrap();
    }
}
#[test]
fn original_owned_documents_are_read_only_and_missing_optional_documents_stay_missing() {
    let tree = Tree::new();
    let (source, config) = tree.setup();
    let before = fs::read(&source).unwrap();
    let mut reader = tree.reader(&source, &config);
    let first = reader.read().unwrap();
    assert!(first.state().is_none() && first.declared_plans().is_none());
    assert!(first.equivalent(&reader.read().unwrap()));
    reader.assert_current(&first).unwrap();
    assert_eq!(fs::read(&source).unwrap(), before);
    assert!(!tree.0.join("state.json").exists());
    assert!(!tree.0.join("subscription-profiles.json").exists());
}
#[test]
fn named_replacement_and_new_optional_file_refuse_without_adopting_new_snapshot() {
    for optional in [false, true] {
        let tree = Tree::new();
        let (source, config) = tree.setup();
        let mut reader = tree.reader(&source, &config);
        let original = reader.read().unwrap();
        if optional {
            tree.write("state.json", b"{\"sessions\":{}}");
        } else {
            fs::rename(
                tree.write("replacement", &fs::read(&source).unwrap()),
                &source,
            )
            .unwrap();
        }
        assert!(reader.assert_current(&original).is_err());
        assert!(reader.read().is_err());
    }
}
#[test]
fn aliases_wrong_uid_and_consumed_source_close_never_return_inventory() {
    let tree = Tree::new();
    let (source, config) = tree.setup();
    let alias = tree.0.join("alias.json");
    symlink(&source, &alias).unwrap();
    assert!(OwnerInventorySource::at(&tree.0, &alias).is_err());
    assert!(OwnerInventorySource::at(&tree.0.join("different"), &source).is_err());
    let scope = OwnerInventorySource::at(&tree.0, &source).unwrap();
    assert!(
        OwnerInventoryReader::capture(
            &scope,
            &config,
            Instant::now() + std::time::Duration::from_secs(5)
        )
        .is_ok()
    );
    assert!(
        OwnerInventoryReader::capture_at(
            &tree.0,
            &alias,
            &config,
            Instant::now() + std::time::Duration::from_secs(5)
        )
        .is_err()
    );
    let wrong = reverie_contracts::worker_config::decode(
        &serde_json::to_vec(&serde_json::json!({"uid":native::policy_effective_uid()+1,
        "companyRoot":tree.0,"companyFile":tree.0.join("company.json")}))
        .unwrap(),
    )
    .unwrap();
    assert!(
        OwnerInventoryReader::capture_at(
            &tree.0,
            &source,
            &wrong,
            Instant::now() + std::time::Duration::from_secs(5)
        )
        .is_err()
    );
    let mut reader = tree.reader(&source, &config);
    native::test_faults::set(None, true);
    assert!(reader.read().err().unwrap().has_unconfirmed_close());
    assert!(reader.read().err().unwrap().has_unconfirmed_close());
}
