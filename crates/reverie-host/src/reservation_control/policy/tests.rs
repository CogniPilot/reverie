use super::*;
use reverie_contracts::worker_config;
use std::{
    os::unix::fs::{MetadataExt, symlink},
    sync::atomic::{AtomicU64, Ordering},
};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Tree(PathBuf);
impl Tree {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "reverie-policy-cas-{}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        let tree = Self(path);
        tree.write("worker.json", b"{\"before\":1}");
        tree
    }
    fn path(&self) -> PathBuf {
        self.0.join("worker.json")
    }
    fn owner(&self) -> u32 {
        fs::metadata(&self.0).unwrap().uid()
    }
    fn write(&self, name: &str, raw: &[u8]) {
        let path = self.0.join(name);
        fs::write(&path, raw).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
    }
    fn held(&self) -> usize {
        fs::read_dir("/proc/self/fd")
            .unwrap()
            .filter_map(|entry| fs::read_link(entry.ok()?.path()).ok())
            .filter(|path| path == &self.0)
            .count()
    }
    fn transaction(&self) -> PolicyTransaction {
        PolicyTransaction::capture(&self.path(), self.owner()).unwrap()
    }
}
impl Drop for Tree {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}
fn candidate() -> PolicyCandidateData {
    PolicyCandidateData::capture(&worker_config::decode(br#"{"after":2}"#).unwrap()).unwrap()
}
#[test]
fn actual_anchored_policy_cas_closes_transaction_before_ack_and_keeps_exact_private_mode() {
    let tree = Tree::new();
    let mut transaction = tree.transaction();
    assert_eq!(transaction.original_bytes(), br#"{"before":1}"#);
    assert_eq!(
        tree.held(),
        1,
        "only actual directory anchor remains, original file is closed"
    );
    let candidate = candidate();
    transaction.write_candidate(&candidate).unwrap();
    let temporary = transaction.temporary.as_ref().unwrap();
    assert_eq!(
        temporary.as_encoded_bytes().len(),
        ".resource-preparing-".len() + 32
    );
    assert_eq!(fs::read(tree.0.join(temporary)).unwrap(), candidate.bytes());
    transaction.assert_directory_current().unwrap();
    transaction.publish().unwrap();
    assert_eq!(tree.held(), 0);
    assert_eq!(fs::read(tree.path()).unwrap(), candidate.bytes());
    assert_eq!(fs::metadata(tree.path()).unwrap().mode() & 0o7777, 0o600);
}
#[test]
fn same_bytes_replacement_is_not_original_inode_and_retains_temp_evidence_without_restore() {
    let tree = Tree::new();
    let mut transaction = tree.transaction();
    transaction.write_candidate(&candidate()).unwrap();
    let temporary = tree.0.join(transaction.temporary.as_ref().unwrap());
    fs::rename(tree.path(), tree.0.join("old-policy")).unwrap();
    tree.write("worker.json", br#"{"before":1}"#);
    assert_eq!(
        transaction.publish().unwrap_err().code(),
        "RESOURCE_PREPARATION_CONFIG_CHANGED"
    );
    assert_eq!(fs::read(tree.path()).unwrap(), br#"{"before":1}"#);
    assert!(temporary.is_file());
    assert!(tree.0.join("old-policy").is_file());
    assert_eq!(tree.held(), 0);
}
#[test]
fn checked_close_failure_after_real_rename_is_uncertain_and_never_restores_original() {
    let tree = Tree::new();
    let mut transaction = tree.transaction();
    let value = candidate();
    transaction.write_candidate(&value).unwrap();
    native::test_faults::set(None, true);
    assert!(transaction.publish().is_err());
    assert_eq!(fs::read(tree.path()).unwrap(), value.bytes());
    assert_eq!(tree.held(), 0);
}
#[test]
fn final_directory_is_private_and_ancestry_aliases_never_become_write_custody() {
    let tree = Tree::new();
    fs::set_permissions(&tree.0, fs::Permissions::from_mode(0o711)).unwrap();
    assert_eq!(
        PolicyTransaction::capture(&tree.path(), tree.owner())
            .err()
            .unwrap()
            .code(),
        "RESERVATION_CONTROL_DIRECTORY"
    );
    fs::set_permissions(&tree.0, fs::Permissions::from_mode(0o700)).unwrap();
    let alias = tree.0.join("alias");
    symlink(&tree.0, &alias).unwrap();
    assert!(PolicyTransaction::capture(&alias.join("worker.json"), tree.owner()).is_err());
    assert_eq!(tree.held(), 0);
}
#[test]
fn changed_parent_refuses_before_policy_publish_and_all_anchors_are_checked_closed() {
    let tree = Tree::new();
    let transaction = tree.transaction();
    let old = tree.0.with_extension("old");
    fs::rename(&tree.0, &old).unwrap();
    fs::create_dir(&tree.0).unwrap();
    fs::set_permissions(&tree.0, fs::Permissions::from_mode(0o700)).unwrap();
    assert_eq!(
        transaction.assert_directory_current().unwrap_err().code(),
        "RESOURCE_PREPARATION_CONFIG_DIRECTORY_CHANGED"
    );
    transaction.close().unwrap();
    fs::remove_dir(&tree.0).unwrap();
    fs::rename(old, &tree.0).unwrap();
    assert_eq!(tree.held(), 0);
}
#[test]
fn private_original_requires_exact_mode_single_link_nofollow_and_raw_bound() {
    let tree = Tree::new();
    fs::set_permissions(tree.path(), fs::Permissions::from_mode(0o400)).unwrap();
    assert_eq!(
        PolicyTransaction::capture(&tree.path(), tree.owner())
            .err()
            .unwrap()
            .code(),
        "PRIVATE_FILE"
    );
    fs::set_permissions(tree.path(), fs::Permissions::from_mode(0o600)).unwrap();
    tree.write("worker.json", b"{}");
    fs::hard_link(tree.path(), tree.0.join("hard")).unwrap();
    assert_eq!(
        PolicyTransaction::capture(&tree.path(), tree.owner())
            .err()
            .unwrap()
            .code(),
        "PRIVATE_FILE"
    );
    fs::remove_file(tree.0.join("hard")).unwrap();
    fs::rename(tree.path(), tree.0.join("real")).unwrap();
    symlink("real", tree.path()).unwrap();
    assert!(PolicyTransaction::capture(&tree.path(), tree.owner()).is_err());
    fs::remove_file(tree.path()).unwrap();
    let maximum = reverie_contracts::operations_v1::MAX_BYTES;
    tree.write("worker.json", &vec![b' '; maximum]);
    tree.transaction().close().unwrap();
    tree.write("worker.json", &vec![b' '; maximum + 1]);
    assert_eq!(
        PolicyTransaction::capture(&tree.path(), tree.owner())
            .err()
            .unwrap()
            .code(),
        "RESOURCE_PREPARATION_CONFIG_CHANGED"
    );
    assert_eq!(tree.held(), 0);
}
#[test]
fn real_primary_drift_and_original_close_fault_remain_separately_inspectable() {
    let tree = Tree::new();
    native::test_faults::set(
        Some(Box::new(|path| {
            fs::write(path, b"changed length")?;
            native::test_faults::set(None, true);
            Ok(())
        })),
        false,
    );
    let error = PolicyTransaction::capture(&tree.path(), tree.owner())
        .err()
        .unwrap();
    let ControlHostError::Finalization { primary, secondary } = error else {
        panic!("retain primary and secondary close failure")
    };
    assert_eq!(primary.code(), "RESOURCE_PREPARATION_CONFIG_CHANGED");
    assert_eq!(secondary.code(), "HOST_ARTIFACT_IO");
    assert_eq!(tree.held(), 0);
}
#[test]
fn actual_binding_rechecks_published_file_then_leaves_validation_before_last_named_stamp() {
    let tree = Tree::new();
    let mut transaction = tree.transaction();
    let mut binding = transaction.binding();
    let data = binding.read_for_validation().unwrap();
    let before = worker_config::decode(br#"{"before":1}"#).unwrap();
    assert!(worker_config::equivalent(
        &before,
        &reverie_contracts::reservation_policy::configuration_for_validation(&data).unwrap()
    ));
    transaction.write_candidate(&candidate()).unwrap();
    transaction.publish().unwrap();
    assert_eq!(
        binding.read_for_validation().err().unwrap().code(),
        "RESOURCE_PREPARATION_CONFIG_CHANGED"
    );
    binding.observe_published_file().unwrap();
    let data = binding.read_for_validation().unwrap();
    let expected = worker_config::decode(br#"{"after":2}"#).unwrap();
    assert!(worker_config::equivalent(
        &expected,
        &reverie_contracts::reservation_policy::configuration_for_validation(&data).unwrap()
    ));
    binding.assert_named_current().unwrap();
    assert_eq!(tree.held(), 0);
    fs::rename(tree.path(), tree.0.join("actual-published")).unwrap();
    tree.write("worker.json", br#"{"after":2}"#);
    assert_eq!(
        binding.assert_named_current().unwrap_err().code(),
        "RESOURCE_PREPARATION_CONFIG_CHANGED"
    );
}
#[test]
fn goal_private_named_ancestry_check_rejects_parent_rebinding_after_real_read_and_retains_close_fault()
 {
    let tree = Tree::new();
    let transaction = tree.transaction();
    let binding = transaction.binding();
    transaction.close().unwrap();
    let root = tree.0.clone();
    let old = tree.0.with_extension("read-rebound");
    let preserved = old.clone();
    native::test_faults::set(
        Some(Box::new(move |_| {
            fs::rename(&root, &old)?;
            fs::create_dir(&root)?;
            fs::set_permissions(&root, fs::Permissions::from_mode(0o700))?;
            native::test_faults::set(None, true);
            Ok(())
        })),
        false,
    );
    let error = binding.read_for_validation().err().unwrap();
    let ControlHostError::Finalization { primary, secondary } = error else {
        panic!("preserve goal ancestry and close errors")
    };
    assert_eq!(primary.code(), "PRIVATE_GOAL_ANCESTRY_CHANGED");
    assert_eq!(secondary.code(), "HOST_ARTIFACT_IO");
    fs::remove_dir(&tree.0).unwrap();
    fs::rename(preserved, &tree.0).unwrap();
    assert_eq!(tree.held(), 0);
}
#[test]
fn goal_private_text_restrictions_remain_at_later_observation_not_the_initial_cas_read() {
    let tree = Tree::new();
    let path = tree.0.join("worker\n.json");
    tree.write("worker\n.json", b"{}");
    let transaction = PolicyTransaction::capture(&path, tree.owner()).unwrap();
    let mut binding = transaction.binding();
    transaction.close().unwrap();
    assert_eq!(
        binding.observe_published_file().unwrap_err().code(),
        "PRIVATE_GOAL_CONFIGURATION_UNAVAILABLE"
    );
    assert_eq!(tree.held(), 0);
}
#[test]
fn candidate_can_cross_old_bound_and_only_readback_refuses_after_actual_publication() {
    let tree = Tree::new();
    let mut transaction = tree.transaction();
    let mut binding = transaction.binding();
    let raw = format!(
        "{{\"x\":\"{}\"}}",
        "a".repeat(reverie_contracts::operations_v1::MAX_BYTES - 7)
    );
    let config = worker_config::decode(raw.as_bytes()).unwrap();
    let candidate = PolicyCandidateData::capture(&config).unwrap();
    assert_eq!(
        candidate.bytes().len(),
        reverie_contracts::operations_v1::MAX_BYTES + 1
    );
    transaction.write_candidate(&candidate).unwrap();
    transaction.publish().unwrap();
    assert_eq!(
        binding.observe_published_file().unwrap_err().code(),
        "PRIVATE_GOAL_ENTRY_BOUND"
    );
    assert_eq!(
        fs::read(tree.path()).unwrap(),
        candidate.bytes(),
        "source leaves the real oversized publication, never restores or retries"
    );
    assert_eq!(tree.held(), 0);
}
