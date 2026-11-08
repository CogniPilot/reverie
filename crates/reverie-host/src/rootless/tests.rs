use super::*;
use reverie_contracts::{
    task_perf_v1::{PerfSystem, TaskPerfManifest, TaskPerfProfile},
    worker_config,
};
use reverie_core::rootless::{SubordinateId, SubordinateRange};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::os::unix::fs::PermissionsExt;
use std::{
    cell::Cell,
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};
static NEXT: AtomicU64 = AtomicU64::new(0);
const RAW: &[u8] = br#"{"defaultAction":"SCMP_ACT_ERRNO","syscalls":[]}"#;
struct Fixture {
    root: PathBuf,
    reads: Cell<usize>,
    perf_reads: Cell<usize>,
    uid_reads: Cell<usize>,
    gid_reads: Cell<usize>,
    uid: u32,
    uid_granted: bool,
    gid_granted: bool,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "reverie-rootless-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        fs::write(root.join("profile"), RAW).unwrap();
        Self {
            root,
            reads: Cell::new(0),
            perf_reads: Cell::new(0),
            uid_reads: Cell::new(0),
            gid_reads: Cell::new(0),
            uid: 1000,
            uid_granted: true,
            gid_granted: true,
        }
    }
    fn config(&self) -> RootlessConfig {
        self.config_for(RAW, false)
    }
    fn config_for(&self, raw: &[u8], perf: bool) -> RootlessConfig {
        let mut config = json!({"uid":1000,"gid":100,"mounts":[{"destination":"/workspace","readOnly":false}],"rootlessDocker":{"enabled":true,"seccompProfile":"/nix/store/rootless-fixture","seccompSha256":format!("{:x}",Sha256::digest(raw))}});
        if perf {
            config["_taskPerfPolicy"] = json!("task-v1");
        }
        RootlessConfig::capture(
            worker_config::decode(&serde_json::to_vec(&config).unwrap()).unwrap(),
        )
        .unwrap()
    }
    fn image(&self) -> RootlessImage {
        RootlessImage::decode(&serde_json::to_vec(&json!({"Config":{"User":"1000:100","Labels":{"org.reverie.worker.rootless-docker":"1","org.reverie.worker.uid":"1000","org.reverie.worker.gid":"100","org.reverie.worker.rootless-docker.mount-layout":"1","org.reverie.worker.subuid-start":"100000","org.reverie.worker.subgid-start":"100000","org.reverie.worker.subid-count":"65536"}}})).unwrap()).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root).unwrap();
    }
}
impl Source for Fixture {
    fn profile(&self, _: &RootlessConfig) -> Result<Vec<u8>> {
        self.reads.set(self.reads.get() + 1);
        Ok(native::observe(
            &self.root.join("profile"),
            65_536,
            crate::task_perf::allowed_metadata,
        )?)
    }
    fn perf(&self, _policy: TaskPerfPolicy) -> Result<TaskPerfArtifactData> {
        self.perf_reads.set(self.perf_reads.get() + 1);
        let selected = TaskPerfProfile::decode(RAW)
            .unwrap()
            .derivative()
            .unwrap()
            .encode();
        let (system, machine) = native::system()?;
        let system = PerfSystem::from_linux_uname(&system, &machine).unwrap();
        let manifest=serde_json::to_vec(&json!({"version":1,"purpose":"worker-task-perf-profile-v1","system":system.name(),"baseProfile":"/nix/store/rootless-base","baseSHA256":format!("{:x}",Sha256::digest(RAW)),"profile":"/nix/store/rootless-fixture","profileSHA256":format!("{:x}",Sha256::digest(&selected))})).unwrap();
        Ok(TaskPerfArtifactData::verify(
            TaskPerfManifest::decode(&manifest, system).unwrap(),
            RAW,
            &selected,
        )
        .unwrap())
    }
    fn uid(&self) -> u32 {
        self.uid
    }
    fn grants(&self, kind: GrantKind, _: u32) -> Result<Vec<SubordinateRange>> {
        let allowed = match kind {
            GrantKind::Uid => {
                self.uid_reads.set(self.uid_reads.get() + 1);
                self.uid_granted
            }
            GrantKind::Gid => {
                self.gid_reads.set(self.gid_reads.get() + 1);
                self.gid_granted
            }
        };
        if allowed {
            Ok(vec![SubordinateRange::new(
                SubordinateId::parse("100000").unwrap(),
                SubordinateId::parse("65536").unwrap(),
            )])
        } else {
            Ok(Vec::new())
        }
    }
}
#[test]
fn disabled_native_operations_ignore_all_source_and_image_account_data() {
    let fixture = Fixture::new();
    fs::remove_file(fixture.root.join("profile")).unwrap();
    let config = RootlessConfig::capture(worker_config::decode(b"{}").unwrap()).unwrap();
    let observed =
        image_observation(&config, &RootlessImage::decode(b"null").unwrap(), &fixture).unwrap();
    assert!(!observed.enabled());
    assert_eq!(observed.security_args().len(), 4);
    assert!(observed.runtime_args().is_empty());
    assert_eq!(fixture.reads.get(), 0);
    assert_eq!(fixture.uid_reads.get(), 0);
    config
        .check_accounts(&[MetadataText::from_scalar_text("invalid//account")])
        .unwrap();
}
#[test]
fn image_readonly_qualification_requires_actual_owner_and_both_exact_host_ranges() {
    let mut fixture = Fixture::new();
    assert!(
        image_observation(&fixture.config(), &fixture.image(), &fixture)
            .unwrap()
            .enabled()
    );
    assert_eq!(fixture.uid_reads.get(), 1);
    assert_eq!(fixture.gid_reads.get(), 1);
    fixture.uid_granted = false;
    fixture.uid_reads.set(0);
    fixture.gid_reads.set(0);
    assert!(image_observation(&fixture.config(), &fixture.image(), &fixture).is_err());
    assert_eq!(fixture.uid_reads.get(), 1);
    assert_eq!(fixture.gid_reads.get(), 0);
    fixture.uid_granted = true;
    fixture.gid_granted = false;
    assert!(image_observation(&fixture.config(), &fixture.image(), &fixture).is_err());
    fixture.uid = 1001;
    fixture.uid_reads.set(0);
    assert!(matches!(
        image_observation(&fixture.config(), &fixture.image(), &fixture),
        Err(RootlessHostError::OwnerMismatch)
    ));
    assert_eq!(fixture.uid_reads.get(), 0);
}
#[test]
fn signed_image_values_preserve_count_then_uid_then_gid_observation_order() {
    let fixture = Fixture::new();
    for (field, uid_reads, gid_reads) in [
        ("org.reverie.worker.subuid-start", 1, 0),
        ("org.reverie.worker.subgid-start", 1, 1),
        ("org.reverie.worker.subid-count", 0, 0),
    ] {
        fixture.uid_reads.set(0);
        fixture.gid_reads.set(0);
        let mut image:serde_json::Value=serde_json::from_slice(br#"{"Config":{"User":"1000:100","Labels":{"org.reverie.worker.rootless-docker":"1","org.reverie.worker.uid":"1000","org.reverie.worker.gid":"100","org.reverie.worker.rootless-docker.mount-layout":"1","org.reverie.worker.subuid-start":"100000","org.reverie.worker.subgid-start":"100000","org.reverie.worker.subid-count":"65536"}}}"#).unwrap();
        image["Config"]["Labels"][field] = json!("-100000");
        let image = RootlessImage::decode(&serde_json::to_vec(&image).unwrap()).unwrap();
        assert!(image_observation(&fixture.config(), &image, &fixture).is_err());
        assert_eq!(fixture.uid_reads.get(), uid_reads, "{field}");
        assert_eq!(fixture.gid_reads.get(), gid_reads, "{field}");
    }
}
#[test]
fn normal_profile_custody_accepts_hardlinks_but_refuses_writes_links_bound_and_hash_drift() {
    let fixture = Fixture::new();
    let path = fixture.root.join("profile");
    let config = fixture.config();
    fs::hard_link(&path, fixture.root.join("other-link")).unwrap();
    assert!(observe(&config, &fixture).is_ok());
    fs::set_permissions(&path, fs::Permissions::from_mode(0o622)).unwrap();
    assert!(observe(&config, &fixture).is_err());
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    fs::write(&path, b"{}").unwrap();
    assert!(observe(&config, &fixture).is_err());
    fs::write(&path, vec![b' '; 65_537]).unwrap();
    assert!(observe(&config, &fixture).is_err());
    fs::remove_file(&path).unwrap();
    std::os::unix::fs::symlink(fixture.root.join("other-link"), &path).unwrap();
    assert!(observe(&config, &fixture).is_err());
    fs::remove_file(&path).unwrap();
    fs::create_dir(&path).unwrap();
    assert!(observe(&config, &fixture).is_err());
}
#[test]
fn profile_replacement_and_close_failure_are_preserved_in_one_refusal() {
    let fixture = Fixture::new();
    let config = fixture.config();
    native::test_faults::set(
        Some(Box::new(|path| {
            fs::rename(path, path.with_extension("retained"))?;
            fs::write(path, RAW)?;
            Ok(())
        })),
        true,
    );
    let error = observe(&config, &fixture).err().unwrap();
    assert!(matches!(
        error,
        RootlessHostError::Observation(ObservationError::Finalization { .. })
    ));
}
#[test]
fn selected_fixed_perf_recognition_does_not_validate_unrelated_employee_policy_maps() {
    let fixture = Fixture::new();
    let selected = TaskPerfProfile::decode(RAW)
        .unwrap()
        .derivative()
        .unwrap()
        .encode();
    fs::write(fixture.root.join("profile"), &selected).unwrap();
    let config = fixture.config_for(&selected, true);
    assert!(observe(&config, &fixture).is_ok());
    let mut raw: serde_json::Value =
        serde_json::from_slice(&worker_config::encode_config(config.configuration())).unwrap();
    raw["employeePerfPolicies"] = json!(null);
    let config =
        RootlessConfig::capture(worker_config::decode(&serde_json::to_vec(&raw).unwrap()).unwrap())
            .unwrap();
    assert!(observe(&config, &fixture).is_ok());
    raw["_taskPerfPolicy"] = json!("forged");
    let config =
        RootlessConfig::capture(worker_config::decode(&serde_json::to_vec(&raw).unwrap()).unwrap())
            .unwrap();
    let before = fixture.perf_reads.get();
    assert!(observe(&config, &fixture).is_err());
    assert_eq!(fixture.perf_reads.get(), before);
}
#[test]
fn malformed_profile_hash_or_default_denial_never_observes_the_fixed_perf_artifact() {
    let fixture = Fixture::new();
    let wrong = fixture.config_for(b"wrong digest", true);
    assert!(observe(&wrong, &fixture).is_err());
    let raw = br#"{"defaultAction":"SCMP_ACT_ALLOW","syscalls":[]}"#;
    fs::write(fixture.root.join("profile"), raw).unwrap();
    assert!(observe(&fixture.config_for(raw, true), &fixture).is_err());
    assert_eq!(fixture.perf_reads.get(), 0);
}
#[test]
fn subid_custody_never_treats_an_owner_writable_file_as_protected_root_metadata() {
    let fixture = Fixture::new();
    let path = fixture.root.join("grants");
    fs::write(&path, b"1000:100000:65536\n").unwrap();
    let result = observe_grants(&path);
    assert_eq!(result.is_ok(), native::uid() == 0);
    fs::set_permissions(&path, fs::Permissions::from_mode(0o666)).unwrap();
    assert!(observe_grants(&path).is_err());
}
