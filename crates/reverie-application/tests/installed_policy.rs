//! Separate readonly qualification against explicitly bound real Nix artifacts.
use reverie_application::resource_staging::effective_config;
use reverie_contracts::worker_config;
use reverie_core::{ids::ProfileSessionId, lease_policy::LeaseAbsolutePath};
use reverie_host::{lease_policy::observe_peer_artifact, task_perf::observe_installed_task_perf};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::fs;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

const PEER: Option<&str> = option_env!("REVERIE_QUALIFICATION_PEER_BINARY");
static NEXT: AtomicU64 = AtomicU64::new(0);

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Fixture {
    #[serde(rename = "oracle")]
    _oracle: String,
    requirements: Requirements,
    company: String,
    session: String,
    input: String,
    expected_config: String,
    expected_policy: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Requirements {
    perf_system: String,
    perf_base_sha256: String,
    perf_profile_sha256: String,
    peer_sha256: String,
}
struct Artifacts {
    base: String,
    profile: String,
    peer: &'static str,
}
impl Artifacts {
    fn observe(required: &Requirements) -> Self {
        let peer = PEER.expect("compile with explicit REVERIE_QUALIFICATION_PEER_BINARY");
        let perf = observe_installed_task_perf()
            .expect("compile host with the qualified REVERIE_FIXED_TASK_PERF_MANIFEST");
        let manifest = perf.data().manifest();
        assert_eq!(manifest.system().name(), required.perf_system);
        assert_eq!(manifest.base_sha256(), required.perf_base_sha256);
        assert_eq!(manifest.profile_sha256(), required.perf_profile_sha256);
        let observed =
            observe_peer_artifact(&LeaseAbsolutePath::from_scalar_text(peer).unwrap()).unwrap();
        assert_eq!(observed.digest().to_hex(), required.peer_sha256);
        Self {
            base: manifest.base_profile().into(),
            profile: manifest.profile().into(),
            peer,
        }
    }
}
struct Tree {
    root: PathBuf,
}
impl Tree {
    fn new(company: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "rpq-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let tree = Self { root };
        let company_file = tree.root.join("company.json");
        fs::write(&company_file, company).unwrap();
        fs::set_permissions(company_file, fs::Permissions::from_mode(0o600)).unwrap();
        tree
    }
    fn substitute(&self, raw: &str, artifacts: &Artifacts) -> String {
        let uid = fs::metadata(&self.root).unwrap().uid();
        assert_ne!(
            uid, 0,
            "the existing lease option requires a non-root broker UID"
        );
        raw.replace("$ROOT", self.root.to_str().unwrap())
            .replace("$UID", &uid.to_string())
            .replace("$PERF_BASE_PROFILE", &artifacts.base)
            .replace("$PERF_PROFILE", &artifacts.profile)
            .replace("$PEER_BINARY", artifacts.peer)
    }
}
impl Drop for Tree {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root).unwrap();
    }
}
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[test]
#[ignore = "requires explicit compile-bound real perf and static peer artifacts; read-only"]
fn selected_gpu_perf_memory_and_lease_match_actual_python_bytes_and_hashes() {
    let fixture: Fixture = serde_json::from_str(include_str!(
        "fixtures/installed-policy-python-interop.json"
    ))
    .unwrap();
    let artifacts = Artifacts::observe(&fixture.requirements);
    let tree = Tree::new(&fixture.company);
    let input = tree.substitute(&fixture.input, &artifacts);
    let expected_config = tree.substitute(&fixture.expected_config, &artifacts);
    let expected_policy = tree.substitute(&fixture.expected_policy, &artifacts);
    let result = effective_config(
        worker_config::decode(input.as_bytes()).unwrap(),
        &ProfileSessionId::parse(&fixture.session).unwrap(),
    )
    .unwrap();
    assert_eq!(
        worker_config::encode_config(&result),
        expected_config.as_bytes()
    );
    assert_eq!(
        worker_config::encode_policy(&result),
        expected_policy.as_bytes()
    );
    assert_eq!(
        worker_config::config_digest(&result).to_hex(),
        digest(expected_config.as_bytes())
    );
    assert_eq!(
        worker_config::policy_digest(&result).to_hex(),
        digest(expected_policy.as_bytes())
    );
    assert_eq!(
        fs::read(tree.root.join("company.json")).unwrap(),
        fixture.company.as_bytes()
    );
    assert_eq!(
        fs::read_dir(&tree.root).unwrap().count(),
        1,
        "projection created state, a socket or a mount directory"
    );
}
