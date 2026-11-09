//! Explicit native fixture controls: immutable existing store inputs only.
//! These never write the store, execute a program or fabricate root ownership.
use super::*;
#[test]
fn worker_child_elf_header_checks_actual_machine_and_rejects_class_byte_order_and_version() {
    let mut file = std::fs::File::open(std::env::current_exe().unwrap()).unwrap();
    let mut header = [0; 64];
    std::io::Read::read_exact(&mut file, &mut header).unwrap();
    let machine = u16::from_le_bytes([header[18], header[19]]);
    require_worker_child_header(&header, machine).unwrap();
    assert!(require_worker_child_header(&header, if machine == 62 { 183 } else { 62 }).is_err());
    for (index, value) in [(0, 0), (4, 1), (5, 2), (6, 0)] {
        let mut changed = header;
        changed[index] = value;
        assert!(require_worker_child_header(&changed, machine).is_err());
    }
    assert!(require_worker_child_header(&header[..20], machine).is_err());
}
use reverie_core::PythonText;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{path::PathBuf, time::Duration};
struct Fixture {
    artifact: PathBuf,
    client: PathBuf,
    raw: Vec<u8>,
    client_digest: JournalDigest,
}
impl Fixture {
    fn new() -> Self {
        let artifact = std::env::var_os("REVERIE_WEBSITE_INPUT_FIXTURE")
            .expect("explicit existing small Nix-store fixture required");
        let client = std::env::var_os("REVERIE_DEPLOYMENT_COPY")
            .expect("explicit existing packaged coreutils ELF required");
        let artifact = fs::canonicalize(artifact).unwrap();
        let client = fs::canonicalize(client).unwrap();
        let raw = read_fixture(&artifact);
        assert!((1..=8192).contains(&raw.len()));
        let client_digest = digest(&read_fixture(&client));
        Self {
            artifact,
            client,
            raw,
            client_digest,
        }
    }
    fn reference(&self) -> ArtifactReference {
        ArtifactReference {
            path: text(&self.artifact),
            sha256: digest(&self.raw),
        }
    }
    fn manifest(&self, path: &Path, digest: &JournalDigest) -> NativeResourceClientManifest {
        NativeResourceClientManifest::decode(
            &serde_json::to_vec(&json!({
                "version":2,"purpose":"resource-replacement-native-client-v2","brokerWireVersion":1,
                "executable":path,"argvPrefix":[path],"executableSHA256":digest.as_str()
            }))
            .unwrap(),
        )
        .unwrap()
    }
}
fn text(path: &Path) -> PythonText {
    PythonText::try_new(native::python_text(path)).unwrap()
}
fn digest(bytes: &[u8]) -> JournalDigest {
    JournalDigest::parse(&format!("{:x}", Sha256::digest(bytes))).unwrap()
}
fn end() -> Instant {
    Instant::now() + Duration::from_secs(10)
}
fn read_fixture(path: &Path) -> Vec<u8> {
    let mut files = Descriptors::default();
    let body = (|| {
        let (index, _) = open(&mut files, path, code::MAX_CODE_FILE, end())?;
        let mut bytes = Vec::new();
        files
            .get_mut(index)
            .take(code::MAX_CODE_FILE + 1)
            .read_to_end(&mut bytes)?;
        Ok(bytes)
    })();
    let mut uncertain = false;
    files.finish(body, &mut uncertain).unwrap()
}
#[test]
#[ignore = "requires explicit REVERIE_WEBSITE_INPUT_FIXTURE and REVERIE_DEPLOYMENT_COPY store paths"]
fn actual_root_owned_store_artifact_and_native_elf_return_bytes_and_inode_data() {
    let fixture = Fixture::new();
    let mut observer = ImmutableInputObserver::default();
    for kind in [
        ImmutableInputKind::Client,
        ImmutableInputKind::Provenance,
        ImmutableInputKind::Startup,
        ImmutableInputKind::PoolImageInputs,
    ] {
        let observed = observer
            .observe_artifact(&fixture.reference(), kind, end())
            .unwrap();
        assert_eq!(observed.bytes(), fixture.raw);
        let info = fs::metadata(&fixture.artifact).unwrap();
        assert_eq!(observed.identity(), [info.dev(), info.ino()]);
    }
    let manifest = fixture.manifest(&fixture.client, &fixture.client_digest);
    let native = observer.observe_native_client(&manifest, end()).unwrap();
    let info = fs::metadata(&fixture.client).unwrap();
    assert_eq!(native.identity(), [info.dev(), info.ino()]);
}
#[test]
#[ignore = "requires explicit REVERIE_WEBSITE_INPUT_FIXTURE and REVERIE_DEPLOYMENT_COPY store paths"]
fn actual_store_wrong_digest_small_bound_and_nonexecutable_selection_refuse() {
    let fixture = Fixture::new();
    let mut observer = ImmutableInputObserver::default();
    let mut reference = fixture.reference();
    reference.sha256 = JournalDigest::parse(&"0".repeat(64)).unwrap();
    assert_eq!(
        observer
            .observe_artifact(&reference, ImmutableInputKind::Client, end())
            .err()
            .unwrap()
            .code(),
        "IMMUTABLE_INPUT_BYTES_CHANGED"
    );
    let large = ArtifactReference {
        path: text(&fixture.client),
        sha256: fixture.client_digest.clone(),
    };
    assert!(
        fs::metadata(&fixture.client).unwrap().len() > 65536,
        "fixed ELF must discriminate input bounds"
    );
    for kind in [
        ImmutableInputKind::Client,
        ImmutableInputKind::Provenance,
        ImmutableInputKind::Startup,
        ImmutableInputKind::PoolImageInputs,
    ] {
        assert_eq!(
            observer
                .observe_artifact(&large, kind, end())
                .err()
                .unwrap()
                .code(),
            "IMMUTABLE_INPUT_CUSTODY"
        );
    }
    let nonexec = fixture.manifest(&fixture.artifact, &digest(&fixture.raw));
    assert_eq!(
        observer
            .observe_native_client(&nonexec, end())
            .err()
            .unwrap()
            .code(),
        "NATIVE_CLIENT_EXECUTABLE_REQUIRED"
    );
    let wrong = fixture.manifest(&fixture.client, &reference.sha256);
    assert_eq!(
        observer
            .observe_native_client(&wrong, end())
            .err()
            .unwrap()
            .code(),
        "BACKEND_CODE_BYTES_CHANGED"
    );
    reference.path = PythonText::from_scalar_text("/etc/passwd");
    assert_eq!(
        observer
            .observe_artifact(&reference, ImmutableInputKind::Client, end())
            .err()
            .unwrap()
            .code(),
        "IMMUTABLE_CODE_PATH"
    );
    observer
        .observe_artifact(&fixture.reference(), ImmutableInputKind::Client, end())
        .unwrap();
}
#[test]
#[ignore = "requires explicit REVERIE_WEBSITE_INPUT_FIXTURE and REVERIE_DEPLOYMENT_COPY store paths"]
fn actual_consumed_close_failure_keeps_primary_and_sticky_observer_without_descriptor_retry() {
    consumed_close_failure(ImmutableInputKind::Client);
}
#[test]
#[ignore = "requires explicit REVERIE_WEBSITE_INPUT_FIXTURE and REVERIE_DEPLOYMENT_COPY store paths"]
fn actual_pool_inputs_close_failure_remains_on_the_original_immutable_reader() {
    consumed_close_failure(ImmutableInputKind::PoolImageInputs);
}
fn consumed_close_failure(kind: ImmutableInputKind) {
    let fixture = Fixture::new();
    let mut observer = ImmutableInputObserver::default();
    let mut wrong = fixture.reference();
    wrong.sha256 = JournalDigest::parse(&"0".repeat(64)).unwrap();
    native::test_faults::set(None, true);
    let first = observer.observe_artifact(&wrong, kind, end());
    native::test_faults::set(None, false);
    let error = first.err().unwrap();
    assert!(
        matches!(error, WebsiteFactsError::Finalization { ref primary, ref secondary }
        if primary.code() == "IMMUTABLE_INPUT_BYTES_CHANGED" && secondary.code() == "BACKEND_CODE_CLOSE_UNCONFIRMED")
    );
    assert_eq!(
        observer
            .observe_artifact(&fixture.reference(), ImmutableInputKind::Client, end())
            .err()
            .unwrap()
            .code(),
        "IMMUTABLE_INPUT_CLOSE_UNCONFIRMED"
    );
    let leaked = fs::read_dir("/proc/self/fd")
        .unwrap()
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| fs::read_link(entry.path()).ok())
        .any(|path| path == fixture.artifact);
    assert!(!leaked, "the actual owned descriptor must be consumed once");
}
