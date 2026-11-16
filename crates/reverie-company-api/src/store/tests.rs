use super::*;
use crate::{api, client};
use http::Method;
use std::{
    collections::BTreeSet,
    fs,
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    sync::{
        Mutex, OnceLock,
        atomic::{AtomicU64, Ordering},
    },
};

static FAULTS: OnceLock<Mutex<BTreeSet<PathBuf>>> = OnceLock::new();
type AfterCurrent = Box<dyn FnOnce() -> Result<()> + Send>;
static AFTER_CURRENT: OnceLock<Mutex<std::collections::BTreeMap<PathBuf, AfterCurrent>>> =
    OnceLock::new();
pub(crate) fn after_current(path: &Path) -> Result<()> {
    let action = AFTER_CURRENT
        .get_or_init(Default::default)
        .lock()
        .unwrap()
        .remove(path);
    action.map_or(Ok(()), |action| action())
}
static GATES: OnceLock<
    Mutex<std::collections::BTreeMap<PathBuf, std::sync::Arc<PublicationGate>>>,
> = OnceLock::new();
pub(crate) struct PublicationGate {
    entered: AtomicU64,
    release: Mutex<bool>,
    wake: std::sync::Condvar,
}
impl PublicationGate {
    pub(crate) fn entered(&self) -> bool {
        self.entered.load(Ordering::SeqCst) != 0
    }
    pub(crate) fn release(&self) {
        *self.release.lock().unwrap() = true;
        self.wake.notify_all();
    }
}
pub(crate) fn hold_publish(path: &Path) -> std::sync::Arc<PublicationGate> {
    let gate = std::sync::Arc::new(PublicationGate {
        entered: AtomicU64::new(0),
        release: Mutex::new(false),
        wake: std::sync::Condvar::new(),
    });
    GATES
        .get_or_init(Default::default)
        .lock()
        .unwrap()
        .insert(path.to_owned(), std::sync::Arc::clone(&gate));
    gate
}
pub(crate) fn before_publish(path: &Path) -> Result<()> {
    let gate = GATES
        .get_or_init(Default::default)
        .lock()
        .unwrap()
        .remove(path);
    if let Some(gate) = gate {
        gate.entered.store(1, Ordering::SeqCst);
        let (released, _) = gate
            .wake
            .wait_timeout_while(
                gate.release.lock().unwrap(),
                std::time::Duration::from_secs(8),
                |released| !*released,
            )
            .unwrap();
        if !*released {
            return Err(Error::Storage);
        }
    }
    Ok(())
}
pub(crate) fn lose_after_rename(path: &Path) -> bool {
    FAULTS
        .get_or_init(Default::default)
        .lock()
        .unwrap()
        .remove(path)
}
struct Root(PathBuf);
impl Root {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "reverie-company-store-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        Self(path)
    }
    fn instance(&self) -> PathBuf {
        self.0.join("office")
    }
}
impl Drop for Root {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}
fn register(store: &CompanyStore, token: &str, request: &str, name: &str) -> Result<Value> {
    api::call(
        store,
        &Method::POST,
        "/api/company/employees",
        token,
        &serde_json::to_vec(&json!({"requestId":request,"name":name})).unwrap(),
    )
}

#[test]
fn unpublished_bootstrap_interruptions_never_block_the_final_name_or_overwrite() {
    for point in [
        BootstrapStage::Staged,
        BootstrapStage::Credential,
        BootstrapStage::Company,
        BootstrapStage::BeforePublish,
    ] {
        let root = Root::new();
        let path = root.instance();
        assert_eq!(
            initialize_checked(&path, |at| if at == point {
                Err(Error::Storage)
            } else {
                Ok(())
            }),
            Err(Error::Storage)
        );
        assert!(!path.exists());
        initialize(&path).unwrap();
        assert_eq!(initialization_status(&path).unwrap()["initialized"], true);
    }
}
#[test]
fn lost_bootstrap_publication_ack_is_inspectable_without_new_owner_or_reset() {
    let root = Root::new();
    let path = root.instance();
    assert_eq!(
        initialize_checked(&path, |at| if at == BootstrapStage::Published {
            Err(Error::Storage)
        } else {
            Ok(())
        }),
        Err(Error::PublicationUnconfirmed)
    );
    let before = fs::read(path.join("company.json")).unwrap();
    let key = fs::read(path.join("owner-credential.json")).unwrap();
    assert_eq!(initialization_status(&path).unwrap()["initialized"], true);
    assert_eq!(initialize(&path), Err(Error::ExistingCompany));
    assert_eq!(fs::read(path.join("company.json")).unwrap(), before);
    assert_eq!(fs::read(path.join("owner-credential.json")).unwrap(), key);
}
#[test]
fn legacy_and_foreign_formats_remain_unchanged_and_cannot_be_bootstrapped() {
    for version in [1, 2, 3] {
        let root = Root::new();
        let path = root.instance();
        fs::create_dir(&path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        let bytes=serde_json::to_vec(&json!({"version":version,"employees":[{"id":"unchanged"}],"unknownNativeIssuedFence":{"request":"retained"}})).unwrap();
        fs::write(path.join("company.json"), &bytes).unwrap();
        fs::set_permissions(path.join("company.json"), fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(initialize(&path), Err(Error::ExistingCompany));
        assert!(matches!(
            CompanyStore::open(&path),
            Err(Error::ExistingCompany)
        ));
        assert_eq!(fs::read(path.join("company.json")).unwrap(), bytes);
        assert!(!path.join("company.json.lock").exists());
        assert!(!path.join("owner-credential.json").exists());
    }
}
#[test]
fn original_metadata_request_survives_unknown_rename_ack_and_blocks_new_writes() {
    let root = Root::new();
    let path = root.instance();
    initialize(&path).unwrap();
    let token = client::credential(&path.join("owner-credential.json")).unwrap();
    let store = CompanyStore::open(&path).unwrap();
    let request = document::new_id().unwrap();
    FAULTS
        .get_or_init(Default::default)
        .lock()
        .unwrap()
        .insert(path.clone());
    assert_eq!(
        register(&store, &token, &request, "First"),
        Err(Error::PublicationUnconfirmed)
    );
    let result = store.operation(&token, &request).unwrap();
    assert_eq!(result["phase"], "registered");
    assert_eq!(result["nativeState"], "unobserved");
    assert_eq!(
        register(&store, &token, &document::new_id().unwrap(), "Second"),
        Err(Error::PublicationUnconfirmed)
    );
    let reopened = CompanyStore::open(&path).unwrap();
    assert_eq!(
        register(&reopened, &token, &request, "First").unwrap(),
        result
    );
    assert_eq!(
        reopened.employees(&token).unwrap()["employees"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}
#[test]
fn replacing_a_child_lock_after_final_check_cannot_split_directory_writers() {
    let root = Root::new();
    let path = root.instance();
    initialize(&path).unwrap();
    let token = client::credential(&path.join("owner-credential.json")).unwrap();
    let store = CompanyStore::open(&path).unwrap();
    let inside_path = path.clone();
    let inside_token = token.clone();
    fs::write(path.join("company.json.lock"), b"untrusted child").unwrap();
    fs::set_permissions(
        path.join("company.json.lock"),
        fs::Permissions::from_mode(0o600),
    )
    .unwrap();
    AFTER_CURRENT
        .get_or_init(Default::default)
        .lock()
        .unwrap()
        .insert(
            path.clone(),
            Box::new(move || {
                fs::rename(
                    inside_path.join("company.json.lock"),
                    inside_path.join("old-lock"),
                )
                .unwrap();
                fs::write(inside_path.join("company.json.lock"), b"replacement").unwrap();
                fs::set_permissions(
                    inside_path.join("company.json.lock"),
                    fs::Permissions::from_mode(0o600),
                )
                .unwrap();
                let other = CompanyStore::open(&inside_path).unwrap();
                assert_eq!(
                    register(
                        &other,
                        &inside_token,
                        &document::new_id().unwrap(),
                        "blocked"
                    ),
                    Err(Error::Busy)
                );
                Ok(())
            }),
        );
    register(&store, &token, &document::new_id().unwrap(), "first").unwrap();
    let other = CompanyStore::open(&path).unwrap();
    register(&other, &token, &document::new_id().unwrap(), "second").unwrap();
    let rows = other.employees(&token).unwrap();
    assert_eq!(rows["employees"].as_array().unwrap().len(), 2);
    let names: BTreeSet<_> = rows["employees"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, BTreeSet::from(["first", "second"]));
}
#[test]
fn stored_json_cannot_fabricate_owner_agent_scope_or_native_success() {
    for corruption in [
        "owner-scope",
        "credential-scope",
        "result-scope",
        "ready-result",
    ] {
        let root = Root::new();
        let path = root.instance();
        initialize(&path).unwrap();
        let token = client::credential(&path.join("owner-credential.json")).unwrap();
        let store = CompanyStore::open(&path).unwrap();
        let request = document::new_id().unwrap();
        let registered = register(&store, &token, &request, "Fixture").unwrap();
        let file = path.join("company.json");
        let mut value: Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
        match corruption {
            "owner-scope" => value["owner"]["employee"] = registered["employeeId"].clone(),
            "credential-scope" => {
                value["credentials"][registered["employeeId"].as_str().unwrap()] = json!({"secretHash":vec![0;32],"employee":registered["employeeId"],"sessionId":document::new_id().unwrap(),"generation":1});
            }
            "result-scope" => {
                value["operations"][&request]["result"]["sessionId"] =
                    json!(document::new_id().unwrap())
            }
            _ => value["operations"][&request]["result"]["phase"] = json!("running"),
        }
        fs::write(&file, serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(CompanyStore::open(&path).is_err());
    }
}
