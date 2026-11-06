//! Actual old require_idle with owned metadata/path fixtures; no admission,
//! live systemd scope, engine operation or execution permission is qualified.
use reverie_contracts::{
    host_jobs::HostJobIntent, operations_v1, reservation_control,
    reservation_engine::ReservationConfiguration, worker_config,
};
use reverie_host::{host_jobs, reservation_control as native_control};
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fs,
    os::unix::fs::{MetadataExt, PermissionsExt, symlink},
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Tree(PathBuf);
impl Tree {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "reverie-host-idle-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        for name in ["control", "control/operations", "work"] {
            fs::create_dir(root.join(name)).unwrap();
        }
        symlink("work", root.join("alias")).unwrap();
        fs::write(root.join("not-directory"), b"owned").unwrap();
        for name in ["", "control", "control/operations", "work"] {
            fs::set_permissions(root.join(name), fs::Permissions::from_mode(0o700)).unwrap();
        }
        Self(root)
    }
    fn write(&self, name: &str, raw: &str) {
        let path = self.0.join("control/operations").join(name);
        fs::write(&path, raw).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
    }
    fn substitute(&self, raw: &str) -> String {
        raw.replace("$ROOT", self.0.to_str().unwrap())
    }
    fn config(&self) -> ReservationConfiguration {
        ReservationConfiguration::capture(worker_config::decode(&serde_json::to_vec(&serde_json::json!({"uid":fs::metadata(&self.0).unwrap().uid(),"stateRoot":self.0.join("state"),"resourceReservations":{"directory":self.0.join("control")}})).unwrap()).unwrap())
    }
}
impl Drop for Tree {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Corpus {
    scope: Value,
    domain_config: String,
    cases: Vec<Case>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    name: String,
    intent_raw: String,
    receipt_raw: Option<String>,
    accepted: bool,
    error: Option<String>,
    error_type: Option<String>,
    old_digest: String,
    receipt_canonical: Option<String>,
    rebind_digest: bool,
}
fn sha(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
fn observe(
    config: &ReservationConfiguration,
    scope: &reverie_core::operations::OperationScope,
    domain: &reservation_control::ControlDomainDigest,
) -> Result<(), String> {
    if native_control::host_job_finishing_present(config)
        .map_err(|error| error.code().to_owned())?
    {
        return Err("HOST_JOB_FINISH_REQUIRES_RECONCILIATION".into());
    }
    let Some(metadata) =
        native_control::read_host_job_intent(config).map_err(|error| error.code().to_owned())?
    else {
        return Ok(());
    };
    let intent = HostJobIntent::capture(&metadata, scope, domain)
        .map_err(|error| error.code().to_owned())?;
    host_jobs::qualify_path_declarations(intent.spec()).map_err(|error| error.code().to_owned())?;
    let receipt = native_control::read_host_job_receipt(config, intent.spec().job_id())
        .map_err(|error| error.code().to_owned())?;
    intent
        .assert_receipt(&receipt)
        .map_err(|error| error.code().to_owned())
}
#[test]
fn all_actual_python_host_idle_metadata_path_order_and_legacy_shapes_match() {
    let corpus: Corpus =
        serde_json::from_str(include_str!("fixtures/host-job-idle-python.json")).unwrap();
    assert_eq!(corpus.cases.len(), 32);
    let scope = operations_v1::decode_scope(&serde_json::to_vec(&corpus.scope).unwrap()).unwrap();
    let domain = reservation_control::domain_digest(
        &worker_config::decode(corpus.domain_config.as_bytes()).unwrap(),
    )
    .unwrap();
    let tree = Tree::new();
    let config = tree.config();
    for case in corpus.cases {
        for entry in fs::read_dir(tree.0.join("control/operations")).unwrap() {
            fs::remove_file(entry.unwrap().path()).unwrap();
        }
        let mut raw = tree.substitute(&case.intent_raw);
        if case.rebind_digest {
            let canonical = tree.substitute(case.receipt_canonical.as_ref().unwrap());
            raw = raw.replace(
                &format!("\"settlementDigest\": \"{}\"", case.old_digest),
                &format!("\"settlementDigest\": \"{}\"", sha(canonical.as_bytes())),
            );
        }
        tree.write("host-job.intent.json", &raw);
        if let Some(receipt) = case.receipt_raw {
            let value: Value = serde_json::from_str(&case.intent_raw).unwrap();
            let job = value["spec"]
                .get("job_id")
                .and_then(Value::as_str)
                .unwrap_or("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
            tree.write(
                &format!("host-job-settled-{job}.json"),
                &tree.substitute(&receipt),
            );
        }
        let result = observe(&config, &scope, &domain);
        assert_eq!(result.is_ok(), case.accepted, "{}: {result:?}", case.name);
        let expected = match case.error_type.as_deref() {
            None => None,
            Some("ScopeUnknown" | "Refused") => case.error,
            Some("TypeError") => Some("FIXED_HOST_JOB_SPEC_REQUIRED".into()),
            Some("FileNotFoundError") => Some("STORAGE_IDENTITY_IO".into()),
            Some("ValueError") => Some("HOST_JOB_FINGERPRINT".into()),
            other => panic!("unclassified Python case: {other:?}"),
        };
        assert_eq!(result.err(), expected, "{}", case.name);
    }
}
#[test]
fn missing_intent_is_only_idle_after_finishing_fence_and_all_file_custody_checks() {
    let tree = Tree::new();
    let config = tree.config();
    assert!(
        native_control::read_host_job_intent(&config)
            .unwrap()
            .is_none()
    );
    symlink(
        "absent",
        tree.0
            .join("control/operations/host-job.finish.pending.json"),
    )
    .unwrap();
    assert!(native_control::host_job_finishing_present(&config).unwrap());
    tree.write("host-job.intent.json", "{}");
    fs::set_permissions(
        tree.0.join("control/operations/host-job.intent.json"),
        fs::Permissions::from_mode(0o400),
    )
    .unwrap();
    assert_eq!(
        native_control::read_host_job_intent(&config)
            .err()
            .unwrap()
            .code(),
        "RESERVATION_PRIVATE_FILE"
    );
}
