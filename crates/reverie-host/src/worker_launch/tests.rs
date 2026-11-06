use super::*;
use reverie_contracts::{storage_identity::decode_metadata, worker_config};
use reverie_core::{
    ids::{ProfileEmployeeId, ProfileSessionId},
    worker_launch::EnvironmentKey,
};
use serde_json::{Value, json};
use std::{
    cell::RefCell,
    os::unix::fs::{PermissionsExt, symlink},
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};
const EID: &str = "11111111-1111-4111-8111-111111111111";
const SID: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
static NEXT: AtomicU64 = AtomicU64::new(0);
thread_local! { static AFTER_ACCOUNT: RefCell<Option<Box<dyn FnOnce()>>> = RefCell::new(None); }
pub(super) fn account_resolved() {
    AFTER_ACCOUNT.with(|slot| {
        if let Some(hook) = slot.borrow_mut().take() {
            hook();
        }
    });
}
struct Tree(PathBuf);
impl Tree {
    fn new() -> Self {
        let root = fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(format!(
                "launch-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        for name in [
            "company/accounts/a",
            "company/accounts/b",
            "company/console/accounts/c",
            "outside",
            "state",
            "scratch",
        ] {
            fs::create_dir_all(root.join(name)).unwrap();
        }
        symlink("a", root.join("company/accounts/alias")).unwrap();
        symlink(root.join("outside"), root.join("company/accounts/escape")).unwrap();
        fs::write(root.join("company/accounts/file"), b"inert").unwrap();
        Self(root)
    }
    fn config(&self) -> Value {
        json!({"companyRoot":self.0.join("company"),"companyFile":self.0.join("company.json"),"uid":native::uid(),"gid":native::uid(),"stateRoot":self.0.join("state"),"scratchRoot":self.0.join("scratch")})
    }
    fn company(&self, raw: &str) {
        fs::write(self.0.join("company.json"), raw).unwrap();
        fs::set_permissions(
            self.0.join("company.json"),
            fs::Permissions::from_mode(0o600),
        )
        .unwrap();
    }
}
impl Drop for Tree {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}
fn config(value: &Value) -> EffectiveWorkerConfig {
    worker_config::decode(&serde_json::to_vec(value).unwrap()).unwrap()
}
fn environment(value: &Value) -> WorkerEnvironment {
    WorkerEnvironment::try_new(
        value
            .as_object()
            .unwrap()
            .iter()
            .map(|(key, value)| {
                (
                    EnvironmentKey::parse(key).unwrap(),
                    value.as_str().unwrap().chars().map(u32::from).collect(),
                )
            })
            .collect(),
    )
    .unwrap()
}
fn corpus() -> Value {
    serde_json::from_str(include_str!("legacy.json")).unwrap()
}
fn strings(values: &[MetadataText]) -> Vec<String> {
    values
        .iter()
        .map(|value| value.scalar_text().unwrap())
        .collect()
}
#[test]
fn actual_python_account_paths_order_deduplication_and_refusals() {
    let tree = Tree::new();
    let corpus = corpus();
    let cases = corpus["accounts"].as_array().unwrap();
    assert_eq!(cases.len(), 19);
    for case in cases {
        let mut source = tree.config();
        if !case["rootless"].is_null() {
            source["rootlessDocker"] = case["rootless"].clone();
        }
        let result = account_mounts(&config(&source), &environment(&case["env"]));
        if case["expected"].is_null() {
            assert!(result.is_err(), "{}", case["name"]);
        } else {
            let expected: Vec<String> = case["expected"]
                .as_array()
                .unwrap()
                .iter()
                .map(|value| {
                    value
                        .as_str()
                        .unwrap()
                        .replace("$ROOT", tree.0.to_str().unwrap())
                })
                .collect();
            assert_eq!(strings(&result.unwrap()), expected, "{}", case["name"]);
        }
    }
}
#[test]
fn duplicate_account_selection_is_reobserved_and_empty_accounts_still_check_rootless() {
    let tree = Tree::new();
    let cfg = config(&tree.config());
    let link = tree.0.join("company/accounts/alias");
    let outside = tree.0.join("outside");
    AFTER_ACCOUNT.with(|slot| {
        *slot.borrow_mut() = Some(Box::new(move || {
            fs::remove_file(&link).unwrap();
            symlink(outside, link).unwrap();
        }))
    });
    let env = environment(
        &json!({"CODEX_HOME":"/instances/default/accounts/alias","CLAUDE_CONFIG_DIR":"/instances/default/accounts/alias"}),
    );
    assert!(matches!(
        account_mounts(&cfg, &env),
        Err(LaunchHostError::AccountUnavailable)
    ));
    let mut source = tree.config();
    source["rootlessDocker"] = json!({"enabled":true,"seccompProfile":"/nix/store/unavailable/profile","seccompSha256":"0".repeat(64)});
    assert!(matches!(
        account_mounts(&config(&source), &environment(&json!({}))),
        Err(LaunchHostError::Rootless(_))
    ));
    assert!(matches!(
        account_mounts(
            &config(&source),
            &environment(&json!({"CODEX_HOME":"/instances/default/accounts/missing"}))
        ),
        Err(LaunchHostError::Io(_))
    ));
}
#[test]
fn actual_python_hostname_names_ignore_session_and_unrelated_registry_shape() {
    let corpus = corpus();
    let cases = corpus["hostnames"].as_array().unwrap();
    assert_eq!(cases.len(), 15);
    let employee = ProfileEmployeeId::parse(EID).unwrap();
    let owner = Some(MetadataText::from_scalar_text("team"));
    for case in cases {
        let metadata = decode_metadata(case["company"].as_str().unwrap().as_bytes()).unwrap();
        let result = worker_launch::employee_hostname(&metadata, &employee, &owner);
        if let Some(expected) = case["expected"].as_str() {
            assert_eq!(result.unwrap(), expected, "{}", case["name"]);
        } else {
            assert!(result.is_err(), "{}", case["name"]);
        }
    }
}
#[test]
fn hostname_is_fresh_owned_metadata_and_session_storage_skips_company_read() {
    let tree = Tree::new();
    tree.company(&json!({"employees":[{"id":EID,"owner":"team","sessionId":SID,"sessionGeneration":1}],"retired":[]}).to_string());
    let identity = storage_identity::StorageIdentityConfig::try_new(
        tree.0.join("company.json"),
        tree.0.join("state"),
        tree.0.join("scratch"),
        native::uid(),
    )
    .unwrap();
    let paths =
        storage_identity::storage_paths(&identity, &ProfileSessionId::parse(SID).unwrap()).unwrap();
    let source = config(&tree.config());
    tree.company(&json!({"employees":[{"id":EID,"owner":"team","sessionId":"historical-ignored","name":"Fresh Name"}],"retired":false}).to_string());
    assert_eq!(
        employee_hostname(&source, &paths).unwrap().as_deref(),
        Some("fresh-name-11111111")
    );
    fs::set_permissions(
        tree.0.join("company.json"),
        fs::Permissions::from_mode(0o666),
    )
    .unwrap();
    assert!(employee_hostname(&source, &paths).is_err());
    tree.company("{\"employees\":[]}");
    let session =
        storage_identity::storage_paths(&identity, &ProfileSessionId::parse(SID).unwrap()).unwrap();
    fs::remove_file(tree.0.join("company.json")).unwrap();
    assert_eq!(employee_hostname(&source, &session).unwrap(), None);
}
#[test]
fn actual_python_raw_cwd_fsencode_hashes_and_tmux_argv() {
    let corpus = corpus();
    for case in corpus["temporary"].as_array().unwrap() {
        if case["cwd"].is_null() {
            assert_eq!(
                serde_json::to_value(worker_launch::temporary_environment(None)).unwrap(),
                case["expected"]
            );
            continue;
        }
        let points = serde_json::from_value(case["cwd"].clone()).unwrap();
        let directory = WorkerDirectory::try_new(points).unwrap();
        let result = temporary_environment(&directory);
        if case["expected"].is_null() {
            assert!(result.is_err());
        } else {
            assert_eq!(
                serde_json::to_value(result.unwrap()).unwrap(),
                case["expected"]
            );
        }
    }
    for case in corpus["tmux"].as_array().unwrap() {
        let command: Vec<Vec<u32>> = serde_json::from_value(case["command"].clone()).unwrap();
        let command = command
            .iter()
            .map(|points| worker_launch::storage_path_text(points).unwrap())
            .collect::<Vec<_>>();
        let name = reverie_core::worker_launch::WorkerName::for_session(
            "demo",
            &ProfileSessionId::parse(SID).unwrap(),
        )
        .unwrap();
        let args = worker_launch::tmux_exec_args(
            &reverie_core::worker_launch::ContainerReference::Worker(&name),
            &command,
            case["attach"].as_bool().unwrap(),
        );
        assert_eq!(
            serde_json::to_value(args.iter().map(|arg| arg.codepoints()).collect::<Vec<_>>())
                .unwrap(),
            case["args"]
        );
    }
}
#[test]
fn actual_python_account_containment_uses_preserved_text_not_native_byte_aliases() {
    let tree = Tree::new();
    let actual = tree.0.join("\u{80}");
    fs::create_dir_all(actual.join("accounts/a")).unwrap();
    symlink(actual.join("accounts/a"), actual.join("accounts/link")).unwrap();
    let corpus = corpus();
    let cases = corpus["pathProvenance"].as_array().unwrap();
    assert_eq!(cases.len(), 4);
    for case in cases {
        let suffix: Vec<u32> = serde_json::from_value(case["suffix"].clone()).unwrap();
        let encoded = suffix
            .iter()
            .map(|cp| format!("\\u{cp:04x}"))
            .collect::<String>();
        let source=serde_json::to_string(&json!({"companyRoot":format!("{}/$SUFFIX",tree.0.display()),"companyFile":tree.0.join("company.json"),"uid":native::uid()})).unwrap().replace("$SUFFIX",&encoded);
        let cfg = worker_config::decode(source.as_bytes()).unwrap();
        let env = environment(
            &json!({"CODEX_HOME":format!("/instances/default/accounts/{}",case["destination"].as_str().unwrap())}),
        );
        assert_eq!(
            account_mounts(&cfg, &env).is_ok(),
            case["accepted"].as_bool().unwrap(),
            "{case}"
        );
    }
}
