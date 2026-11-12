//! Actual packaged decoder regression with synthetic producer DATA only.
//! It creates no broker, controller channel, resource grant or worker process.
use crate::test_docker as docker;
use reverie_contracts::{worker_config, worker_pool::*};
use sha2::{Digest, Sha256};
use std::{fs, os::unix::fs::PermissionsExt, path::PathBuf};

fn retained_birth() -> Vec<u8> {
    let uid = nix::unistd::geteuid().as_raw();
    let gid = nix::unistd::getegid().as_raw();
    assert!(uid > 0 && gid > 0, "ordinary owned fixture required");
    let policy = WorkerPoolPolicy {
        version: 1,
        purpose: PURPOSE.into(),
        deployment: "birth-fixture".into(),
        instance_root: "/home/synthetic/reverie".into(),
        engine_id: "11111111-1111-4111-8111-111111111111".into(),
        anchor_image: format!("sha256:{}", "a".repeat(64)),
        controller_image: format!("sha256:{}", "b".repeat(64)),
        website_container: "c".repeat(64),
        broker_uid: uid,
        broker_gid: gid,
        memory_max_mi_b: MEMORY_MAX_MIB,
        pool_tasks_max: TASKS_MAX,
        cpu_weight: 100,
        allowed_cpus: vec![0],
        employee_memory_high_mi_b: [("22222222-2222-4222-8222-222222222222".into(), 8192)].into(),
    };
    let process = BrokerBirthData::from_observations(
        42,
        "100".into(),
        [uid, gid],
        [1, 2],
        [3, 4, 5],
        "d".repeat(64),
    )
    .unwrap();
    let program = BrokerProgramData::decode(
        &serde_json::to_vec(&serde_json::json!({
            "version":1,"purpose":"reverie-native-worker-broker-v1",
            "executable":"/nix/store/synthetic-broker/bin/reverie-worker-broker",
            "executableSHA256":"e".repeat(64),"bytes":4096
        }))
        .unwrap(),
    )
    .unwrap();
    let birth = ControllerBirthV2::from_observations(policy.clone(), process, program).unwrap();
    let config = worker_config::decode(
        &serde_json::to_vec(&serde_json::json!({"workerPoolProvider":{
            "version":1,"purpose":"reverie-docker-worker-pool-provider-v1","policy":policy
        }}))
        .unwrap(),
    )
    .unwrap();
    let provider = WorkerPoolProvider::from_config(&config).unwrap().unwrap();
    let anchor = serde_json::from_value(serde_json::json!({
        "containerId":"a".repeat(64),"originalBirthDigest":"b".repeat(64),
        "bootId":"11111111-1111-4111-8111-111111111111","pid":42,"processStart":"100",
        "parentIdentity":[12,22],"leafIdentity":[12,27]
    }))
    .unwrap();
    ControllerServiceBirth::from_installed_provider(birth, &provider, Some(anchor))
        .unwrap()
        .encode()
        .unwrap()
}

struct Probe {
    root: PathBuf,
    name: String,
    id: Option<String>,
    image: String,
}
impl Probe {
    fn new(image: String) -> Self {
        assert!(image.strip_prefix("sha256:").is_some_and(hex_id));
        let measured: serde_json::Value = serde_json::from_str(
            &docker::run(&["image", "inspect", "--format", "{{json .}}", &image]).unwrap(),
        )
        .unwrap();
        assert_eq!(measured["Id"], image);
        let mut nonce = [0; 8];
        getrandom::getrandom(&mut nonce).unwrap();
        let nonce: String = nonce.iter().map(|byte| format!("{byte:02x}")).collect();
        let name = format!("reverie-birth-fixture-{nonce}");
        let root = std::env::temp_dir().join(&name);
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o750)).unwrap();
        Self {
            root,
            name,
            id: None,
            image,
        }
    }
    fn create(&mut self, raw: &[u8]) {
        let digest = format!("{:x}", Sha256::digest(raw));
        let file = self.root.join(format!("{digest}.json"));
        fs::write(&file, raw).unwrap();
        fs::set_permissions(file, fs::Permissions::from_mode(0o440)).unwrap();
        let policy = format!(
            "type=bind,source={},target=/run/reverie-worker-pool/policies,readonly",
            self.root.display()
        );
        let user = format!("0:{}", nix::unistd::getegid().as_raw());
        let id = docker::run(&[
            "create",
            "--pull",
            "never",
            "--name",
            &self.name,
            "--label",
            "reverie.fixture=controller-birth-v3-check",
            "--user",
            &user,
            "--pid",
            "host",
            "--userns",
            "host",
            "--cgroupns",
            "host",
            "--cgroup-parent",
            "system.slice",
            "--network",
            "none",
            "--read-only",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges:true",
            "--memory",
            "268435456",
            "--memory-swap",
            "268435456",
            "--pids-limit",
            "128",
            "--mount",
            &policy,
            "--mount",
            "type=bind,source=/proc,target=/run/reverie-host-proc,readonly",
            &self.image,
            "serve",
            "--confinement-version",
            "2",
            "--birth-sha256",
            &digest,
        ])
        .unwrap()
        .trim()
        .to_owned();
        assert!(hex_id(&id));
        self.id = Some(id);
        self.assert_owned(false);
    }
    fn assert_owned(&self, running: bool) {
        let id = self.id.as_deref().unwrap();
        let row: serde_json::Value =
            serde_json::from_str(&docker::run(&["inspect", "--format", "{{json .}}", id]).unwrap())
                .unwrap();
        assert_eq!(row["Id"], id);
        assert_eq!(row["Name"], format!("/{}", self.name));
        assert_eq!(row["Image"], self.image);
        assert_eq!(
            row["Config"]["Labels"]["reverie.fixture"],
            "controller-birth-v3-check"
        );
        assert_eq!(row["State"]["Running"], running);
        assert!(row["Mounts"].as_array().unwrap().iter().all(|mount| {
            mount["RW"] == false
                && [
                    "/run/reverie-worker-pool/policies",
                    "/run/reverie-host-proc",
                ]
                .contains(&mount["Destination"].as_str().unwrap())
        }));
    }
    fn close(mut self) {
        self.assert_owned(false);
        docker::run(&["rm", self.id.as_deref().unwrap()]).unwrap();
        self.id = None;
        fs::remove_dir_all(&self.root).unwrap();
    }
}
impl Drop for Probe {
    fn drop(&mut self) {
        if self.id.is_some() {
            eprintln!(
                "Owned birth-decoder fixture retained: {} {:?}",
                self.root.display(),
                self.id
            );
        }
    }
}

#[test]
#[ignore = "requires explicit already-loaded immutable legacy controller image; owned disposable Docker only"]
fn actual_packaged_legacy_controller_rejects_real_retained_v3_producer_before_engine_or_channel() {
    let raw = retained_birth();
    assert!(ControllerBirthV2::decode(&raw).is_err());
    ControllerServiceBirth::decode(&raw).unwrap();
    let image =
        std::env::var("REVERIE_CONTROLLER_LEGACY_IMAGE").expect("explicit immutable legacy image");
    let mut fixture = Probe::new(image);
    fixture.create(&raw);
    let failure = docker::run(&["start", "--attach", fixture.id.as_deref().unwrap()]).unwrap_err();
    fixture.assert_owned(false);
    assert!(failure.contains("WORKER_POOL_POLICY_INVALID"), "{failure}");
    assert!(
        !failure.contains("WORKER_POOL_ENGINE"),
        "decoder must fail before engine initialization"
    );
    fixture.close();
}

fn inert_runtime() -> (
    crate::worker_runtime::WorkerRuntime,
    std::sync::Arc<std::sync::atomic::AtomicUsize>,
) {
    use reverie_core::{
        resources::{BudgetMode, CpuQuota, ResourcePolicy},
        worker_schema::{WorkerBase, WorkerIds},
    };
    let capture = crate::engine_metadata::EngineBootstrap::from_service(
        std::env::current_exe().unwrap().as_os_str(),
        Default::default(),
        std::env::temp_dir().canonicalize().unwrap(),
    )
    .unwrap();
    let starts = capture.hooks.starts.clone();
    let base = WorkerBase::try_new(
        "birth-fixture".into(),
        "fixture-server".into(),
        format!("sha256:{}", "a".repeat(64)),
        WorkerIds::try_new(
            nix::unistd::geteuid().as_raw(),
            nix::unistd::getegid().as_raw(),
        )
        .unwrap(),
        4,
        ResourcePolicy::try_new(
            BudgetMode::Admission,
            1024,
            128,
            CpuQuota::from_integer(1).unwrap(),
            8192,
            512,
        )
        .unwrap(),
    )
    .unwrap();
    (
        crate::worker_runtime::WorkerRuntime::new(
            crate::installed_worker_engine::InstalledWorkerEngine::new(capture),
            &base,
        ),
        starts,
    )
}

#[test]
#[ignore = "requires exact immutable current factory image-input manifest and executable; decoder component only"]
fn actual_factory_pinned_current_decoder_consumes_produced_retained_birth_without_engine_or_publication()
 {
    use super::*;
    use reverie_contracts::resource_actor::ArtifactReference;
    use reverie_core::{PythonText, operations::JournalDigest};
    use std::time::{Duration, Instant};
    let reference = ArtifactReference {
        path: PythonText::from_scalar_text(
            &std::env::var("REVERIE_CONTROLLER_CHECK_INPUTS").expect("immutable factory inputs"),
        ),
        sha256: JournalDigest::parse(
            &std::env::var("REVERIE_CONTROLLER_CHECK_INPUTS_SHA256")
                .expect("exact factory inputs hash"),
        )
        .unwrap(),
    };
    let (runtime, starts) = inert_runtime();
    let end = Instant::now() + Duration::from_secs(10);
    let mut owner = ControllerBirthCompatibility::new(&runtime, end);
    let measured = owner
        .immutable
        .observe_artifact(&reference, ImmutableInputKind::PoolImageInputs, end)
        .unwrap();
    let inputs = PoolImageInputsData::decode(measured.bytes()).unwrap();
    let program = inputs
        .controller_program()
        .expect("actual image/program factory binding");
    let raw = retained_birth();
    let checked = owner.check_decoder(program, &raw, end);
    let repeated = owner.check_decoder(program, &raw, end);
    let closed = owner.close();
    runtime.close(end).unwrap();
    checked.unwrap();
    closed.unwrap();
    assert!(
        repeated.is_err(),
        "same decoder owner never launches another check"
    );
    assert_eq!(starts.load(std::sync::atomic::Ordering::SeqCst), 0);
}
