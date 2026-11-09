use super::*;
use reverie_contracts::broker_resources::{self, ResourceConfigError};
use reverie_core::{
    ids::ProfileEmployeeId,
    profiles::ProfileDocument,
    revision::{ObservedProfileVersion, StoreRevision},
};
use serde::Deserialize;
use std::os::unix::fs::PermissionsExt;
use std::{
    collections::BTreeMap,
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};
#[path = "tests_memory_v2.rs"]
mod memory_v2_cases;

#[derive(Deserialize)]
struct Corpus {
    cases: Vec<Case>,
}
#[derive(Deserialize)]
struct Case {
    input: String,
    document: String,
    employee: String,
    revision: u64,
    version: u64,
    owners: BTreeMap<String, String>,
    output: String,
    target: String,
    profile_sha256: String,
}
#[derive(Deserialize)]
struct EffectiveCorpus {
    staged: Vec<Expected>,
}
#[derive(Deserialize)]
struct Expected {
    index: usize,
    effective: String,
    config_sha256: String,
    policy_sha256: String,
}
fn cases() -> Vec<Case> {
    serde_json::from_str::<Corpus>(include_str!(
        "../../../reverie-contracts/tests/fixtures/broker-resource-staging.json"
    ))
    .unwrap()
    .cases
}
fn request(case: &Case, revision: u64) -> ProfileStageRequest {
    let doc: ProfileDocument = profiles_v1::decode(case.document.as_bytes()).unwrap();
    let employee = ProfileEmployeeId::parse(&case.employee).unwrap();
    let owners = case
        .owners
        .iter()
        .map(|(s, e)| {
            (
                ProfileSessionId::parse(s).unwrap(),
                ProfileEmployeeId::parse(e).unwrap(),
            )
        })
        .collect();
    ProfileStageRequest::try_new(
        employee.clone(),
        doc.profiles()[&employee].binding().clone(),
        StoreRevision::try_new(revision).unwrap(),
        ObservedProfileVersion::try_new(case.version).unwrap(),
        &owners,
    )
    .unwrap()
}
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Tree {
    root: PathBuf,
}
impl Tree {
    fn new(case: &Case) -> Self {
        let root = std::env::temp_dir().join(format!(
            "reverie-stage-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let tree = Self { root };
        tree.write("profiles.json", case.document.as_bytes());
        tree
    }
    fn write(&self, name: &str, bytes: &[u8]) {
        let path = self.root.join(name);
        fs::write(&path, bytes).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
    }
    fn store(&self) -> ProfileStore {
        ProfileStore::open(&self.root).unwrap()
    }
    fn replace_profile(&self) {
        self.write("replacement.json", b"{}");
        fs::rename(
            self.root.join("replacement.json"),
            self.root.join("profiles.json"),
        )
        .unwrap();
    }
}
impl Drop for Tree {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root).unwrap();
    }
}
#[test]
fn all_original_python_stages_match_real_locked_store_configuration_and_hashes() {
    let expected: EffectiveCorpus = serde_json::from_str(include_str!(
        "../../../reverie-contracts/tests/fixtures/resource-config-python-interop.json"
    ))
    .unwrap();
    let cases = cases();
    assert_eq!(expected.staged.len(), 6);
    for expected in expected.staged {
        let case = &cases[expected.index];
        let tree = Tree::new(case);
        let before = fs::read(tree.root.join("profiles.json")).unwrap();
        let store = tree.store();
        let result = stage_config(
            &store,
            broker_resources::decode(case.input.as_bytes()).unwrap(),
            &request(case, case.revision),
        )
        .unwrap();
        assert_eq!(
            worker_config::encode_config(result.configuration()),
            case.output.as_bytes()
        );
        assert_eq!(
            worker_config::encode_config(result.effective_configuration()),
            expected.effective.as_bytes()
        );
        assert_eq!(
            result.effective_config_digest().to_hex(),
            expected.config_sha256
        );
        assert_eq!(
            result.effective_policy_digest().to_hex(),
            expected.policy_sha256
        );
        assert_eq!(result.profile_digest().to_hex(), case.profile_sha256);
        assert_eq!(result.resources().target_session().as_str(), case.target);
        assert_eq!(result.resources().store_revision().get(), case.revision);
        assert_eq!(result.resources().profile_version().get(), case.version);
        assert_eq!(fs::read(tree.root.join("profiles.json")).unwrap(), before);
        store.close().unwrap();
    }
}
#[test]
fn stale_revision_stops_before_any_effective_config_resolution() {
    let case = cases().remove(0);
    let tree = Tree::new(&case);
    let store = tree.store();
    let result = stage_using(
        &store,
        broker_resources::decode(case.input.as_bytes()).unwrap(),
        &request(&case, case.revision + 1),
        |_, _| panic!("stale profile reached native resolution"),
    );
    assert_eq!(result.err().unwrap().code(), "STALE_STORE_REVISION");
    store.close().unwrap();
}
#[test]
fn changed_original_profile_custody_invalidates_an_otherwise_resolved_candidate() {
    let case = cases().remove(0);
    let tree = Tree::new(&case);
    let store = tree.store();
    let result = stage_using(
        &store,
        broker_resources::decode(case.input.as_bytes()).unwrap(),
        &request(&case, case.revision),
        |config, sid| {
            let result = effective_config(config, sid)?;
            tree.replace_profile();
            Ok(result)
        },
    );
    assert!(matches!(result, Err(ResourceServiceError::Store(_))));
    store.close().unwrap();
}
#[test]
fn native_resolution_error_and_profile_finalization_error_are_both_retained() {
    let case = cases().remove(0);
    let tree = Tree::new(&case);
    let store = tree.store();
    let result = stage_using(
        &store,
        broker_resources::decode(case.input.as_bytes()).unwrap(),
        &request(&case, case.revision),
        |_, _| {
            tree.replace_profile();
            Err(ResourceConfigError::ResourceShape.into())
        },
    );
    let Err(ResourceServiceError::Finalization { primary, finalizer }) = result else {
        panic!("both errors must survive");
    };
    assert_eq!(primary.code(), "RESOURCE_CONFIG_SHAPE");
    assert!(!finalizer.code().is_empty());
    store.close().unwrap();
}

#[test]
fn inactive_features_and_explicit_legacy_gpu_need_no_identity_paths_or_package() {
    let sid = ProfileSessionId::parse("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa").unwrap();
    let raw = format!(
        r#"{{"employeeGpuGrants":{{"11111111-1111-4111-8111-111111111111":"nvidia.com/gpu=GPU-12345678-1234-1234-1234-123456789abc"}},"gpuGrants":{{"{}":"nvidia.com/gpu=GPU-abcdef12-abcd-abcd-abcd-abcdefabcdef"}},"employeePerfPolicies":{{}},"employeeMemoryPolicies":false,"laptopSwapPoolMiB":"inactive","opaque":"\ud800"}}"#,
        sid.as_str()
    );
    let result = effective_config(worker_config::decode(raw.as_bytes()).unwrap(), &sid).unwrap();
    let expected = format!(
        r#"{{"gpuGrants": {{"{}": "nvidia.com/gpu=GPU-abcdef12-abcd-abcd-abcd-abcdefabcdef"}}, "opaque": "\ud800"}}"#,
        sid.as_str()
    );
    assert_eq!(worker_config::encode_config(&result), expected.as_bytes());
}

#[derive(Deserialize)]
struct NativeCorpus {
    cases: Vec<NativeCase>,
}
#[derive(Deserialize)]
struct NativeCase {
    name: String,
    company: String,
    moves: Option<String>,
    session: String,
    input: String,
    output: String,
}
#[test]
fn actual_native_company_and_history_match_python_without_inferring_current_grants() {
    use std::os::unix::fs::MetadataExt;
    let fixture: NativeCorpus = serde_json::from_str(include_str!(
        "../../tests/fixtures/native-resource-python-interop.json"
    ))
    .unwrap();
    assert_eq!(fixture.cases.len(), 2);
    for case in fixture.cases {
        let tree = Tree::new(&cases().remove(0));
        tree.write("company.json", case.company.as_bytes());
        if let Some(moves) = case.moves {
            tree.write("plan-moves.json", moves.as_bytes());
        }
        let uid = fs::metadata(&tree.root).unwrap().uid();
        let substitute = |raw: &str| {
            raw.replace("$ROOT", tree.root.to_str().unwrap())
                .replace("$UID", &uid.to_string())
        };
        let input = substitute(&case.input);
        let result = effective_config(
            worker_config::decode(input.as_bytes()).unwrap(),
            &ProfileSessionId::parse(&case.session).unwrap(),
        )
        .unwrap();
        assert_eq!(
            worker_config::encode_config(&result),
            substitute(&case.output).as_bytes(),
            "{}",
            case.name
        );
        assert!(
            !tree.root.join("state").exists(),
            "read-side resolver created employee state"
        );
        assert!(
            !tree.root.join("scratch").exists(),
            "read-side resolver created scratch state"
        );
    }
}
