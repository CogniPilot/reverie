use super::*;
mod image;
use reverie_contracts::worker_config::encode_config;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::cell::{Cell, RefCell};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::sync::atomic::{AtomicU64, Ordering};
static NEXT: AtomicU64 = AtomicU64::new(0);
const EMPLOYEE: &str = "11111111-2222-4333-8444-555555555555";
const SESSION: &str = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const BASE: &str = "/nix/store/fixed-base-profile";
const SELECTED: &str = "/nix/store/fixed-task-profile";
type Hook = Box<dyn FnMut()>;
struct Fixture {
    root: PathBuf,
    reads: Cell<usize>,
    hook: RefCell<Option<Hook>>,
    manifest: Vec<u8>,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "reverie-perf-observation-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let base=br#"{"defaultAction":"SCMP_ACT_ERRNO","syscalls":[{"names":["read"],"action":"SCMP_ACT_ALLOW"}]}"#;
        let selected = TaskPerfProfile::decode(base)
            .unwrap()
            .derivative()
            .unwrap()
            .encode();
        fs::write(root.join("base"), base).unwrap();
        fs::write(root.join("selected"), &selected).unwrap();
        let (system, machine) = native::system().unwrap();
        let system = PerfSystem::from_linux_uname(&system, &machine).unwrap();
        let manifest=serde_json::to_vec(&json!({"version":1,"purpose":"worker-task-perf-profile-v1","system":system.name(),"baseProfile":BASE,"baseSHA256":format!("{:x}",Sha256::digest(base)),"profile":SELECTED,"profileSHA256":format!("{:x}",Sha256::digest(&selected))})).unwrap();
        let result = Self {
            root,
            reads: Cell::new(0),
            hook: RefCell::new(None),
            manifest,
        };
        result.company("owner-a", 1, false, true);
        result
    }
    fn company_file(&self) -> PathBuf {
        self.root.join("company.json")
    }
    fn company(&self, owner: &str, generation: u32, running: bool, vacation: bool) {
        Self::write_company(&self.company_file(), owner, generation, running, vacation);
    }
    fn write_company(path: &Path, owner: &str, generation: u32, running: bool, vacation: bool) {
        fs::write(path,serde_json::to_vec(&json!({"employees":[{"id":EMPLOYEE,"sessionId":SESSION,"sessionGeneration":generation,"owner":owner,"desiredRunning":running,"onVacation":vacation}],"retired":[]})).unwrap()).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
    }
    fn identity(&self) -> StorageIdentityConfig {
        StorageIdentityConfig::try_new(
            self.company_file(),
            self.root.join("state"),
            self.root.join("scratch"),
            native::uid(),
        )
        .unwrap()
    }
    fn config(&self, selected: bool) -> TaskPerfConfiguration {
        let manifest = TaskPerfManifest::decode(&self.manifest, actual_system()).unwrap();
        let employee = if selected {
            EMPLOYEE
        } else {
            "22222222-2222-4333-8444-555555555555"
        };
        TaskPerfConfiguration::decode(&serde_json::to_vec(&json!({"employeePerfPolicies":{employee:"task-v1"},"rootlessDocker":{"enabled":true,"seccompProfile":BASE,"seccompSha256":manifest.base_sha256()},"unrelated":"preserved"})).unwrap()).unwrap()
    }
    fn project(&self, config: &TaskPerfConfiguration) -> Result<TaskPerfProjection> {
        let identity = self.identity();
        let session = ProfileSessionId::parse(SESSION).unwrap();
        project(
            config,
            || Ok(storage_identity::current_employee(&identity, &session)?),
            self,
        )
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root).unwrap();
    }
}
fn actual_system() -> PerfSystem {
    let (system, machine) = native::system().unwrap();
    PerfSystem::from_linux_uname(&system, &machine).unwrap()
}
impl ArtifactSource for Fixture {
    fn manifest(&self) -> Result<PathBuf> {
        Ok("/nix/store/fixed-perf-manifest".into())
    }
    fn read(&self, path: &Path) -> Result<Vec<u8>> {
        self.reads.set(self.reads.get() + 1);
        let leaf = match path.to_str().unwrap() {
            "/nix/store/fixed-perf-manifest" => "manifest",
            BASE => "base",
            SELECTED => "selected",
            _ => panic!("unexpected artifact selection"),
        };
        if leaf == "manifest" {
            fs::write(self.root.join(leaf), &self.manifest).unwrap();
        }
        let path = native::canonical_in(&self.root.join(leaf), &self.root)?;
        let raw = native::observe(&path, MAX_ARTIFACT_BYTES, allowed_metadata)?;
        if let Some(mut hook) = self.hook.borrow_mut().take() {
            hook();
        }
        Ok(raw)
    }
}

#[test]
fn real_current_employee_is_bracketed_without_overriding_off_or_vacation_gates() {
    let fixture = Fixture::new();
    let candidate = fixture.project(&fixture.config(true)).unwrap();
    assert!(candidate.selected());
    assert_eq!(fixture.reads.get(), 3);
    let identity = fixture.identity();
    let session = ProfileSessionId::parse(SESSION).unwrap();
    let paths = storage_identity::storage_paths(&identity, &session).unwrap();
    assert!(!storage_identity::storage_start_allowed(&identity, &paths).unwrap());
    let config: serde_json::Value =
        serde_json::from_slice(&encode_config(candidate.configuration())).unwrap();
    assert_eq!(config["rootlessDocker"]["seccompProfile"], SELECTED);
    assert_eq!(config["unrelated"], "preserved");
}

#[test]
fn empty_or_other_employee_policy_does_not_observe_the_installed_artifact() {
    let fixture = Fixture::new();
    let empty = TaskPerfConfiguration::decode(b"{}").unwrap();
    let candidate = project(
        &empty,
        || panic!("empty map must not read identity"),
        &fixture,
    )
    .unwrap();
    assert!(!candidate.selected());
    assert!(!fixture.project(&fixture.config(false)).unwrap().selected());
    assert_eq!(fixture.reads.get(), 0);
}

#[test]
fn owner_or_generation_changes_while_observing_artifacts_refuse_the_candidate() {
    for owner in ["owner-a", "other-owner"] {
        let fixture = Fixture::new();
        let company = fixture.company_file();
        let generation = if owner == "owner-a" { 2 } else { 1 };
        fixture.hook.replace(Some(Box::new(move || {
            Fixture::write_company(&company, owner, generation, false, true)
        })));
        assert!(matches!(
            fixture.project(&fixture.config(true)),
            Err(TaskPerfHostError::CurrentEmployeeChanged)
        ));
    }
}

#[test]
fn selected_artifact_hash_derivative_and_base_policy_are_checked_without_repair() {
    let fixture = Fixture::new();
    let config = fixture.config(true);
    fs::write(fixture.root.join("selected"), b"foreign bytes").unwrap();
    assert!(fixture.project(&config).is_err());
    assert_eq!(
        fs::read(fixture.root.join("selected")).unwrap(),
        b"foreign bytes"
    );
}

#[test]
fn absent_compile_binding_refuses_and_a_forged_marker_needs_no_artifact_io() {
    if FIXED_MANIFEST.is_none() {
        assert!(matches!(
            observe_installed_task_perf(),
            Err(TaskPerfHostError::Unconfigured)
        ));
    } else {
        assert!(observe_installed_task_perf().is_ok());
    }
    let config = TaskPerfConfiguration::decode(b"{}").unwrap();
    let profile = TaskPerfProfile::decode(b"{}").unwrap();
    assert!(matches!(
        recognized_task_perf(&config, &profile),
        Err(TaskPerfHostError::Data(TaskPerfError::Marker))
    ));
}
