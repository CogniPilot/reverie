use reverie_application::{
    worker_launch::{prepare_create, validate_request},
    worker_validation::validate_captured,
};
use reverie_contracts::{resource_config::ResourceConfiguration, worker_config};
use reverie_core::ids::ProfileSessionId;
use reverie_host::worker_identity;
use reverie_store::storage_identity;
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    fs,
    os::unix::fs::{MetadataExt, PermissionsExt},
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};
static NEXT: AtomicU64 = AtomicU64::new(0);
#[derive(Deserialize)]
struct Corpus {
    cases: Vec<Case>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    name: String,
    source: String,
    company: String,
    moves: Option<String>,
    session: String,
    expected_name: String,
    expected_digest: String,
    expected_effective: String,
    expected_policy: String,
    expected_args: Vec<String>,
    environment: serde_json::Value,
    expected_accounts: Vec<String>,
    kind: String,
}
struct Tree(PathBuf);
impl Tree {
    fn new() -> Self {
        let root = fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(format!(
                "launch-app-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        for name in [
            "work/attachments",
            "state",
            "scratch",
            "company/accounts/a",
            "office",
        ] {
            fs::create_dir_all(root.join(name)).unwrap();
        }
        Self(root)
    }
    fn substitute(&self, raw: &str) -> String {
        let path = serde_json::to_string(self.0.to_str().unwrap()).unwrap();
        let info = fs::metadata(&self.0).unwrap();
        raw.replace("$ROOT", &path[1..path.len() - 1])
            .replace("$UID", &info.uid().to_string())
            .replace("$GID", &info.gid().to_string())
    }
    fn write(&self, name: &str, raw: &str) {
        fs::write(self.0.join(name), self.substitute(raw)).unwrap();
        fs::set_permissions(self.0.join(name), fs::Permissions::from_mode(0o600)).unwrap();
    }
}
impl Drop for Tree {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}
fn digest(raw: &str) -> String {
    format!("{:x}", Sha256::digest(raw.as_bytes()))
}
#[test]
fn actual_python_full_native_create_data_and_late_original_config_accounts() {
    let corpus: Corpus = serde_json::from_str(include_str!("fixtures/worker_launch.json")).unwrap();
    assert_eq!(corpus.cases.len(), 3);
    for case in corpus.cases {
        let tree = Tree::new();
        tree.write("company.json", &case.company);
        if let Some(moves) = case.moves {
            tree.write("state/plan-moves.json", &moves);
        }
        let config = worker_config::decode(tree.substitute(&case.source).as_bytes()).unwrap();
        let snapshot = validate_captured(config).unwrap();
        let session = ProfileSessionId::parse(&case.session).unwrap();
        let captured = ResourceConfiguration::capture(snapshot.configuration().clone()).unwrap();
        let identity =
            worker_identity::storage_identity(&captured.identity_settings().unwrap()).unwrap();
        let paths = storage_identity::storage_paths(&identity, &session).unwrap();
        assert_eq!(paths.employee().is_some(), case.kind == "employee");
        let request=validate_request(&serde_json::to_vec(&json!({"sessionId":case.session,"cwd":"/workspace/a","command":"printf hi","env":case.environment,"cols":80,"rows":24})).unwrap(),&snapshot).unwrap();
        let plan = prepare_create(&snapshot, &session, &paths).unwrap();
        assert_eq!(plan.storage(), &paths);
        assert_eq!(plan.session(), &session);
        assert_eq!(
            worker_config::encode_config(plan.source()),
            worker_config::encode_config(snapshot.configuration())
        );
        let expected = tree.substitute(&case.expected_effective);
        let policy = tree.substitute(&case.expected_policy);
        assert_eq!(
            worker_config::encode_config(plan.effective_configuration()),
            expected.as_bytes(),
            "{}",
            case.name
        );
        assert_eq!(plan.arguments().name(), case.expected_name);
        assert_eq!(plan.arguments().config_digest().to_hex(), digest(&expected));
        assert_eq!(plan.arguments().policy_digest().to_hex(), digest(&policy));
        let expected_args = case
            .expected_args
            .iter()
            .map(|arg| {
                if arg.starts_with("reverie.worker-config=") {
                    format!("reverie.worker-config={}", digest(&expected))
                } else if arg.starts_with("reverie.worker-policy=") {
                    format!("reverie.worker-policy={}", digest(&policy))
                } else {
                    tree.substitute(arg)
                }
            })
            .collect::<Vec<_>>();
        let actual = plan
            .arguments()
            .args()
            .iter()
            .map(|arg| arg.scalar_text().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            actual, expected_args,
            "{} (original oracle digest {})",
            case.name, case.expected_digest
        );
        assert_eq!(
            plan.account_mounts(&request)
                .unwrap()
                .iter()
                .map(|arg| arg.scalar_text().unwrap())
                .collect::<Vec<_>>(),
            case.expected_accounts
                .iter()
                .map(|arg| tree.substitute(arg))
                .collect::<Vec<_>>()
        );
        let other = ProfileSessionId::parse("00000000-0000-0000-0000-000000000000").unwrap();
        assert!(prepare_create(&snapshot, &other, &paths).is_err());
    }
}
