use super::projection::{self, Source};
use super::*;
use reverie_contracts::lease_policy::LeaseConfig;
use reverie_contracts::worker_config::encode_config;
use reverie_core::ids::ProfileSessionId;
use std::os::unix::fs::{MetadataExt, PermissionsExt, symlink};
use std::{
    cell::Cell,
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};

const E: &str = "11111111-2222-4333-8444-555555555555";
const S: &str = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const F: &str = "99999999-8888-4777-8666-555555555555";
static NEXT: AtomicU64 = AtomicU64::new(0);
fn sid(value: &str) -> ProfileSessionId {
    ProfileSessionId::parse(value).unwrap()
}
fn config(company: &str, uid: u32) -> LeaseConfig {
    LeaseConfig::decode(format!("{{\"uid\":{uid},\"socket\":\"/host/broker.sock\",\"stateRoot\":\"/host/state\",\"companyFile\":\"{company}\",\"mounts\":[],\"leaseAcceptance\":{{\"socket\":\"/host/state/peer/peer.sock\",\"employeeId\":\"{E}\",\"leaseSubdirectory\":\".\",\"peerBinary\":\"/nix/store/synthetic-peer\"}}}}").as_bytes()).unwrap()
}
struct Synthetic {
    company_reads: Cell<usize>,
    artifact_reads: Cell<usize>,
    fail_artifact: bool,
}
impl Synthetic {
    fn new() -> Self {
        Self {
            company_reads: Cell::new(0),
            artifact_reads: Cell::new(0),
            fail_artifact: false,
        }
    }
}
impl Source for Synthetic {
    fn company(&self, _: &LeaseConfig) -> Result<Vec<u8>> {
        self.company_reads.set(self.company_reads.get() + 1);
        Ok(format!("{{\"employees\":[{{\"id\":\"{E}\",\"sessionId\":\"{S}\",\"owner\":[],\"desiredRunning\":false,\"onVacation\":true}}]}}").into_bytes())
    }
    fn artifact(&self, path: &LeaseAbsolutePath) -> Result<PeerArtifactObservation> {
        self.artifact_reads.set(self.artifact_reads.get() + 1);
        if self.fail_artifact {
            return Err(LeaseHostError::ImmutableNix);
        }
        Ok(artifact::synthetic_observation(path))
    }
}
#[test]
fn disabled_and_unselected_grants_never_observe_a_peer_artifact() {
    let source = Synthetic::new();
    let disabled = projection::project(
        LeaseConfig::decode(br#"{"leaseAcceptance":null,"payload":-0.0}"#).unwrap(),
        &sid(S),
        &source,
    )
    .unwrap();
    assert_eq!(
        encode_config(disabled.config()),
        br#"{"leaseAcceptance": null, "payload": -0.0}"#
    );
    assert_eq!(source.company_reads.get(), 0);
    let unselected =
        projection::project(config("/synthetic/company", 1000), &sid(F), &source).unwrap();
    assert!(unselected.artifact().is_none());
    assert_eq!(source.company_reads.get(), 1);
    assert_eq!(source.artifact_reads.get(), 0);
    assert!(
        !String::from_utf8(encode_config(unselected.config()))
            .unwrap()
            .contains("leaseAcceptance")
    );
}
#[test]
fn selected_projection_observes_once_without_adding_running_or_owner_gates() {
    let source = Synthetic::new();
    let selected =
        projection::project(config("/synthetic/company", 1000), &sid(S), &source).unwrap();
    assert!(selected.artifact().is_some());
    assert_eq!(source.company_reads.get(), 1);
    assert_eq!(source.artifact_reads.get(), 1);
    let value: serde_json::Value =
        serde_json::from_slice(&encode_config(selected.config())).unwrap();
    assert_eq!(
        value["mounts"],
        serde_json::json!([{"source":"/nix/store/synthetic-peer","destination":"/opt/reverie-acceptance-peer","readOnly":true}])
    );
    assert!(value.get("leaseAcceptance").is_none());
    let failing = Synthetic {
        fail_artifact: true,
        ..Synthetic::new()
    };
    assert!(projection::project(config("/synthetic/company", 1000), &sid(S), &failing).is_err());
    assert_eq!(failing.company_reads.get(), 1);
    assert_eq!(failing.artifact_reads.get(), 1);
}
struct Tree {
    root: PathBuf,
}
impl Tree {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "reverie-lease-reader-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        Self { root }
    }
    fn company(&self) -> PathBuf {
        self.root.join("company.json")
    }
    fn config(&self) -> LeaseConfig {
        config(
            self.company().to_str().unwrap(),
            fs::metadata(&self.root).unwrap().uid(),
        )
    }
    fn write(&self) {
        fs::write(
            self.company(),
            format!("{{\"employees\":[{{\"id\":\"{E}\",\"sessionId\":\"{S}\"}}]}}"),
        )
        .unwrap();
    }
}
impl Drop for Tree {
    fn drop(&mut self) {
        crate::native::test_faults::set(None, false);
        fs::remove_dir_all(&self.root).unwrap();
    }
}
#[test]
fn lease_company_reader_preserves_its_weaker_write_mode_policy_but_not_links_or_aliases() {
    let tree = Tree::new();
    tree.write();
    fs::set_permissions(tree.company(), fs::Permissions::from_mode(0o666)).unwrap();
    assert!(projection::company(&tree.config()).is_ok());
    let link = tree.root.join("linked");
    fs::hard_link(tree.company(), &link).unwrap();
    assert!(projection::company(&tree.config()).is_err());
    fs::remove_file(&link).unwrap();
    fs::rename(tree.company(), &link).unwrap();
    symlink(&link, tree.company()).unwrap();
    assert!(projection::company(&tree.config()).is_err());
}
#[test]
fn installed_projection_does_not_read_artifact_for_foreign_sid_and_refuses_owned_non_nix_binary() {
    let tree = Tree::new();
    tree.write();
    let foreign = project_lease(tree.config(), &sid(F)).unwrap();
    assert!(foreign.artifact().is_none());
    assert!(project_lease(tree.config(), &sid(S)).is_err());
    let path = LeaseAbsolutePath::from_scalar_text(tree.company().to_str().unwrap()).unwrap();
    assert!(observe_peer_artifact(&path).is_err());
}
#[test]
fn native_path_encoding_preserves_surrogateescape_but_refuses_other_surrogates() {
    let value = LeaseAbsolutePath::try_new(vec![47, 0xdcff]).unwrap();
    use std::os::unix::ffi::OsStrExt;
    assert_eq!(
        native_path(&value).unwrap().as_os_str().as_bytes(),
        b"/\xff"
    );
    assert!(native_path(&LeaseAbsolutePath::try_new(vec![47, 0xd800]).unwrap()).is_err());
}

#[test]
fn company_descriptor_walk_refuses_a_symlinked_ancestor_even_for_the_same_file() {
    let tree = Tree::new();
    tree.write();
    let alias = tree.root.with_extension("alias");
    symlink(&tree.root, &alias).unwrap();
    let selected = config(
        alias.join("company.json").to_str().unwrap(),
        fs::metadata(&tree.root).unwrap().uid(),
    );
    let result = projection::company(&selected);
    fs::remove_file(&alias).unwrap();
    assert!(result.is_err());
}

#[test]
fn company_exact_one_mib_bound_uid_and_missing_file_are_preserved() {
    let tree = Tree::new();
    tree.write();
    let mut bytes = fs::read(tree.company()).unwrap();
    bytes.resize(1024 * 1024, b' ');
    fs::write(tree.company(), &bytes).unwrap();
    assert_eq!(
        projection::company(&tree.config()).unwrap().len(),
        1024 * 1024
    );
    bytes.push(b' ');
    fs::write(tree.company(), bytes).unwrap();
    assert!(projection::company(&tree.config()).is_err());
    tree.write();
    let wrong = config(
        tree.company().to_str().unwrap(),
        fs::metadata(&tree.root).unwrap().uid() + 1,
    );
    assert!(projection::company(&wrong).is_err());
    fs::remove_file(tree.company()).unwrap();
    assert!(projection::company(&tree.config()).is_err());
    assert!(!tree.company().exists());
}

#[test]
fn company_replacement_and_data_close_failure_retain_both_errors() {
    let tree = Tree::new();
    tree.write();
    crate::native::test_faults::set(
        Some(Box::new(|path| {
            fs::rename(path, path.with_extension("saved")).unwrap();
            fs::write(path, b"{}").unwrap();
            crate::native::test_faults::set(None, true);
            Ok(())
        })),
        false,
    );
    let error = projection::company(&tree.config()).unwrap_err();
    let LeaseHostError::Observation(crate::ObservationError::Finalization { primary, secondary }) =
        error
    else {
        panic!("lost company read/close evidence");
    };
    assert_eq!(primary.code(), "HOST_ARTIFACT_CHANGED");
    assert_eq!(secondary.code(), "HOST_ARTIFACT_IO");
}

#[test]
fn directory_walk_close_failure_refuses_before_any_projection() {
    let tree = Tree::new();
    tree.write();
    crate::native::test_faults::set(None, true);
    assert!(project_lease(tree.config(), &sid(F)).is_err());
    let descriptors = fs::read_dir("/proc/self/fd")
        .unwrap()
        .filter_map(|entry| fs::read_link(entry.unwrap().path()).ok())
        .filter(|path| path.starts_with(&tree.root))
        .count();
    assert_eq!(descriptors, 0);
}
