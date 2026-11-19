mod evidence;

use reverie_contracts::worker_config::{self, EffectiveWorkerConfig};
use reverie_core::ids::ProfileSessionId;
use reverie_host::worker_storage::{self, StorageLease};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, DirBuilder, OpenOptions},
    io::Write,
    os::unix::{
        fs::{DirBuilderExt, OpenOptionsExt, symlink},
        net::UnixListener,
    },
    path::{Path, PathBuf},
    process::{Command, Output},
    sync::atomic::{AtomicU32, Ordering},
    time::SystemTime,
};

pub(crate) const EMPLOYEE: &str = "11111111-2222-4333-8444-555555555555";
pub(crate) const SESSION: &str = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
pub(crate) const OPERATION: &str = "99999999-8888-4777-8666-555555555555";
pub(crate) const BASE: &str = "/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-fixture-base";
const PRIOR: &str = "/nix/store/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-old-base";
pub(crate) const COMMAND: &str = "reverie-worker-store-maintenance";
static NEXT: AtomicU32 = AtomicU32::new(0);

pub(crate) struct Sandbox(PathBuf);

impl Sandbox {
    pub(crate) fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "os-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        DirBuilder::new().mode(0o700).create(&path).unwrap();
        Self(path.canonicalize().unwrap())
    }

    pub(crate) fn docker(&self) -> PathBuf {
        let command = self.0.join("docker");
        let source =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/support/offline_store/docker.rs");
        let status = Command::new("rustc")
            .args(["--edition=2024", "-o"])
            .arg(&command)
            .arg(source)
            .status()
            .unwrap();
        assert!(status.success());
        command
    }
}

impl Drop for Sandbox {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

pub(crate) struct Fixture {
    _socket: UnixListener,
    sandbox: Sandbox,
    pub(crate) source: EffectiveWorkerConfig,
    pub(crate) session: ProfileSessionId,
    pub(crate) employee_lock: PathBuf,
    pub(crate) session_lock: PathBuf,
    pub(crate) fence: PathBuf,
    pub(crate) store: PathBuf,
    pub(crate) home: PathBuf,
    cli: PathBuf,
}

impl Fixture {
    pub(crate) fn new(docker: &Path) -> Self {
        let sandbox = Sandbox::new();
        let root = &sandbox.0;
        let cli = root.join(COMMAND);
        let binary = std::env::var_os("REVERIE_TEST_OFFLINE_STORE_CLI")
            .unwrap_or_else(|| env!("CARGO_BIN_EXE_reverie-admin-memory").into());
        symlink(binary, &cli).unwrap();
        symlink(docker, root.join("docker")).unwrap();
        let _socket = UnixListener::bind(root.join("docker.sock")).unwrap();
        let source = write_config(root);
        let session = ProfileSessionId::parse(SESSION).unwrap();
        let mut lease = StorageLease::acquire_launch(&source, &session).unwrap();
        lease.prepare_runtime_directory().unwrap();
        lease.prepare_storage().unwrap();
        lease.record_storage_binding().unwrap();
        let paths = lease.paths().clone();
        lease.close().unwrap();
        let locks = worker_storage::lock_paths(&source, &paths).unwrap();
        let session_lock = root.join("state").join(SESSION).join("nix.lock");
        private(&session_lock, b"");
        let fixture = Self {
            _socket,
            sandbox,
            source,
            session,
            employee_lock: locks.lock().to_owned(),
            session_lock,
            fence: locks.migration_fence().to_owned(),
            store: paths.nix().to_owned(),
            home: paths.home().to_owned(),
            cli,
        };
        fixture.seed_store();
        fixture.evidence(false);
        fixture
    }

    fn seed_store(&self) {
        fs::create_dir(self.store.join("store")).unwrap();
        fs::create_dir_all(self.store.join("var/nix/profiles")).unwrap();
        fs::create_dir(self.store.join("var/nix/gcroots")).unwrap();
        symlink(PRIOR, self.store.join("var/nix/gcroots/reverie-image")).unwrap();
        fs::write(self.home.join("keep"), "owner data").unwrap();
        for (name, path) in [
            ("employee-lock", &self.employee_lock),
            ("session-lock", &self.session_lock),
            ("fence-path", &self.fence),
            ("nix-path", &self.store),
            ("fence-leaf", &self.fence),
            ("lock-leaf", &self.employee_lock),
            ("receipt-leaf", &self.receipt_path()),
        ] {
            self.write(name, path.as_os_str().as_encoded_bytes());
        }
        symlink(
            self.path(&format!("state/offline-store-maintenance/{OPERATION}.json")),
            self.path("prepared-audit"),
        )
        .unwrap();
        self.write("base", BASE.as_bytes());
    }

    pub(crate) fn path(&self, leaf: &str) -> PathBuf {
        self.sandbox.0.join(leaf)
    }

    pub(crate) fn write(&self, leaf: &str, bytes: &[u8]) {
        private(&self.path(leaf), bytes);
    }

    pub(crate) fn command(&self) -> Command {
        let mut command = Command::new(&self.cli);
        command
            .current_dir(&self.sandbox.0)
            .env("PATH", &self.sandbox.0)
            .arg("--config")
            .arg(self.path("broker.json"))
            .arg("--validated-target")
            .arg(self.path("target.json"))
            .args(["--employee", EMPLOYEE, "--operation", OPERATION]);
        command
    }

    pub(crate) fn plan(&self) -> Value {
        let plan = success(self.command().output().unwrap());
        let args = plan["facts"]["helperArgs"].as_array().unwrap();
        let mut expected = vec![
            "--label".to_owned(),
            format!("reverie.offline-store-operation={OPERATION}"),
            "--restart".into(),
            "no".into(),
        ];
        expected.extend(args[1..].iter().map(|arg| arg.as_str().unwrap().to_owned()));
        self.write("expected-args", expected.join("\0").as_bytes());
        plan
    }

    pub(crate) fn apply(&self, plan: &Value) -> Output {
        self.command()
            .args([
                "--apply",
                "--expected-plan-digest",
                plan["planDigest"].as_str().unwrap(),
            ])
            .output()
            .unwrap()
    }

    pub(crate) fn calls(&self) -> Vec<String> {
        fs::read_to_string(self.path("effect-log"))
            .unwrap_or_default()
            .lines()
            .map(str::to_owned)
            .collect()
    }

    pub(crate) fn receipt_path(&self) -> PathBuf {
        self.path(&format!(
            "state/offline-store-maintenance/{OPERATION}.prepared-store.json"
        ))
    }
}

pub(crate) fn success(output: Output) -> Value {
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

pub(crate) fn error(output: Output, status: i32, state: &str) -> Value {
    assert_eq!(
        output.status.code(),
        Some(status),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stdout.is_empty());
    let error: Value = serde_json::from_slice(&output.stderr).unwrap();
    assert_eq!(error["state"], state);
    assert_eq!(error["automaticRetry"], false);
    error
}

fn write_config(root: &Path) -> EffectiveWorkerConfig {
    for name in ["state", "scratch", "public", "office", "broker"] {
        DirBuilder::new()
            .mode(0o700)
            .create(root.join(name))
            .unwrap();
    }
    private(
        &root.join("company.json"),
        &serde_json::to_vec(&json!({"employees":[employee()],"retired":[]})).unwrap(),
    );
    let config = json!({
        "version":1,"deployment":"fixture","image":image(),
        "serverContainer":"fixture-web","socket":root.join("broker/control.sock"),"stateRoot":root.join("state"),
        "companyFile":root.join("company.json"),"companyRoot":root.join("office"),
        "scratchRoot":root.join("scratch"),"apiSocketRoot":root.join("api"),
        "budgetMode":"admission","uid":nix::unistd::getuid().as_raw(),"gid":nix::unistd::getgid().as_raw(),
        "memoryMiB":512,"poolMemoryMiB":1024,"poolTasksMax":256,"cgroupParent":"reverie-workers.slice",
        "pidsLimit":128,"cpus":1,"maxWorkers":4,
        "mounts":[{"source":root.join("public"),"destination":"/workspace","readOnly":false}],
        "maintenanceSessions":[],
    });
    let bytes = serde_json::to_vec(&config).unwrap();
    private(&root.join("broker.json"), &bytes);
    worker_config::decode_offline_store(&bytes).unwrap()
}

fn employee() -> Value {
    json!({"id":EMPLOYEE,"sessionId":SESSION,"sessionGeneration":1,"owner":"owner-a",
        "desiredRunning":false,"onVacation":true,
        "runtimeRecipe":{"mode":"codex","subscriptionProfile":{"id":"fixture-account"}}})
}

fn private(path: &Path, data: &[u8]) {
    OpenOptions::new()
        .write(true)
        .truncate(true)
        .create(true)
        .mode(0o600)
        .open(path)
        .unwrap()
        .write_all(data)
        .unwrap();
}

pub(crate) fn digest(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}

fn image() -> String {
    format!("sha256:{}", "1".repeat(64))
}

pub(crate) fn expiry(seconds: f64) -> f64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap()
        .as_secs_f64()
        + seconds
}
