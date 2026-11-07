use super::*;
use std::{
    fs,
    os::unix::fs::{PermissionsExt, symlink},
    sync::atomic::{AtomicU64, Ordering},
};
static NEXT: AtomicU64 = AtomicU64::new(0);
const SESSION: &str = "00000000-0000-0000-0000-000000000000";
struct Tree(PathBuf);
impl Tree {
    fn new() -> Self {
        let root = PathBuf::from(std::env::var_os("HOME").unwrap()).join(format!(
            ".reverie-intent-test-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        Self(root)
    }
    fn write(&self, name: &str, raw: &[u8]) {
        let file = self.0.join(name);
        fs::write(&file, raw).unwrap();
        fs::set_permissions(file, fs::Permissions::from_mode(0o600)).unwrap();
    }
    fn config(&self, uid: Option<u32>) -> EffectiveWorkerConfig {
        let mut value = serde_json::json!({"companyFile":self.0.join("company.json")});
        if let Some(uid) = uid {
            value["uid"] = uid.into();
        }
        reverie_contracts::worker_config::decode(&serde_json::to_vec(&value).unwrap()).unwrap()
    }
}
impl Drop for Tree {
    fn drop(&mut self) {
        native::test_faults::set(None, false);
        fs::remove_dir_all(&self.0).unwrap();
    }
}
fn sid() -> ProfileSessionId {
    ProfileSessionId::parse(SESSION).unwrap()
}
#[test]
fn selected_current_employee_precedes_uid_and_plan_reads() {
    let tree = Tree::new();
    tree.write(
        "company.json",
        format!("{{\"employees\":[{{\"sessionId\":\"{SESSION}\",\"desiredRunning\":0}},null]}}")
            .as_bytes(),
    );
    tree.write("plan-moves.json", b"invalid");
    assert!(read_allowed(&tree.config(None), &sid()).unwrap());
    tree.write("company.json", b"{\"employees\":[]}");
    assert_eq!(
        read_allowed(&tree.config(None), &sid()).unwrap_err().code(),
        "WORKER_INTENT_CONFIGURATION"
    );
    assert_eq!(
        read_allowed(&tree.config(Some(native::uid())), &sid())
            .unwrap_err()
            .code(),
        "WORKER_PLAN_UNAVAILABLE"
    );
}
#[test]
fn company_follows_alias_and_modes_but_plan_has_real_metadata_custody() {
    let tree = Tree::new();
    tree.write("actual.json", b"{\"employees\":[]}");
    fs::set_permissions(
        tree.0.join("actual.json"),
        fs::Permissions::from_mode(0o666),
    )
    .unwrap();
    symlink(tree.0.join("actual.json"), tree.0.join("company.json")).unwrap();
    let config = tree.config(Some(native::uid()));
    assert!(read_allowed(&config, &sid()).unwrap()); // missing journal is allowed
    tree.write("journal.json", b"[]");
    symlink(tree.0.join("journal.json"), tree.0.join("plan-moves.json")).unwrap();
    assert_eq!(
        read_allowed(&config, &sid()).unwrap_err().code(),
        "WORKER_PLAN_UNAVAILABLE"
    );
    fs::remove_file(tree.0.join("plan-moves.json")).unwrap();
    tree.write(
        "plan-moves.json",
        format!("[{{\"oldSession\":\"{SESSION}\",\"phase\":\"completed\"}},null]").as_bytes(),
    );
    assert!(!read_allowed(&config, &sid()).unwrap());
}
#[test]
fn company_structure_missing_files_and_checked_close_never_become_allowed() {
    let tree = Tree::new();
    let config = tree.config(Some(native::uid()));
    assert_eq!(
        read_allowed(&config, &sid()).unwrap_err().code(),
        "WORKER_COMPANY_UNAVAILABLE"
    );
    tree.write("company.json", b"{\"employees\":[null]}");
    assert_eq!(
        read_allowed(&config, &sid()).unwrap_err().code(),
        "WORKER_COMPANY_STRUCTURE"
    );
    tree.write(
        "company.json",
        format!("{{\"employees\":[{{\"sessionId\":\"{SESSION}\"}}]}}").as_bytes(),
    );
    native::test_faults::set(None, true);
    assert_eq!(
        read_allowed(&config, &sid()).unwrap_err().code(),
        "WORKER_COMPANY_UNAVAILABLE"
    );
    assert!(read_allowed(&config, &sid()).unwrap());
}
