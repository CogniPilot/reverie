#![cfg(feature = "test-fixtures")]
//! Exercise the real supervisor with native child processes and an empty PATH.
use nix::sys::signal::{Signal, kill};
use nix::unistd::Pid;
use std::fs;
use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        let mut random = [0_u8; 8];
        getrandom::getrandom(&mut random).unwrap();
        let suffix: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
        let path = std::env::temp_dir().join(format!("reverie-container-test-{suffix}"));
        fs::DirBuilder::new().mode(0o700).create(&path).unwrap();
        fs::write(path.join("model.gguf"), "synthetic model fixture").unwrap();
        Self(path)
    }

    fn command(&self, model: bool) -> Command {
        let fixture = env!("CARGO_BIN_EXE_reverie-container-fixture");
        let mut command = Command::new(env!("CARGO_BIN_EXE_reverie-container-runtime"));
        command
            .env_clear()
            .env("PATH", "")
            .env("TMPDIR", &self.0)
            .env("REVERIE_DATA", &self.0)
            .env("REVERIE_FIXTURE_STATE", &self.0)
            .env("REVERIE_GPU_PUBLISHER", fixture)
            .env("REVERIE_MODEL_RELAY", fixture)
            .env("REVERIE_MODEL_RELAY_SCRIPT", "relay-fixture")
            .arg(fixture)
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        if model {
            command
                .env("REVERIE_LLAMA_SERVER", fixture)
                .env("REVERIE_LOCAL_MODEL", self.0.join("model.gguf"))
                .env("REVERIE_LOCAL_MODEL_ALIAS", "selected-model")
                .env("REVERIE_LOCAL_MODEL_SAMPLING_PROFILE", "qwen3.8-thinking");
        }
        command
    }

    fn ready(&self, role: &str) -> i32 {
        let path = self.0.join(format!("{role}.pid"));
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if let Ok(value) = fs::read_to_string(&path)
                && let Ok(pid) = value.parse()
            {
                return pid;
            }
            assert!(Instant::now() < deadline, "{role} did not start");
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn wait(child: &mut Child) -> std::process::ExitStatus {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            return status;
        }
        if Instant::now() >= deadline {
            child.kill().unwrap();
            panic!("container supervisor did not settle its children");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn terminate(child: &mut Child) {
    kill(
        Pid::from_raw(i32::try_from(child.id()).unwrap()),
        Signal::SIGTERM,
    )
    .unwrap();
    assert!(wait(child).success());
}

#[test]
fn runs_without_a_host_profile_or_host_control_programs_and_reaps_children() {
    let fixture = Fixture::new();
    let mut child = fixture.command(true).spawn().unwrap();
    let pids: Vec<_> = ["model", "relay", "telemetry", "website"]
        .map(|role| fixture.ready(role))
        .into();
    let model_args = fs::read_to_string(fixture.0.join("model.args")).unwrap();
    assert!(model_args.contains("--alias\nselected-model\n"));
    assert!(model_args.contains("--cache-type-k\nf16\n--cache-type-v\nf16\n"));
    assert!(model_args.contains("preserve_thinking"));
    let telemetry = fs::read_to_string(fixture.0.join("telemetry-path")).unwrap();
    assert!(Path::new(&telemetry).starts_with(&fixture.0));
    let key = fixture.0.join("runtime/model/api-key");
    let original_key = fs::read(&key).unwrap();
    assert_eq!(
        fs::metadata(&key).unwrap().permissions().mode() & 0o777,
        0o600
    );
    terminate(&mut child);
    for pid in pids {
        assert!(kill(Pid::from_raw(pid), None).is_err());
    }
    assert!(!Path::new(&telemetry).parent().unwrap().exists());
    let mut again = fixture.command(true).spawn().unwrap();
    std::thread::sleep(Duration::from_millis(100));
    terminate(&mut again);
    assert_eq!(fs::read(key).unwrap(), original_key);
}

#[test]
fn a_helper_failure_exits_for_docker_to_restart_the_whole_container() {
    for role in ["model", "relay", "telemetry"] {
        let fixture = Fixture::new();
        let mut child = fixture
            .command(true)
            .env("REVERIE_FIXTURE_FAIL", role)
            .spawn()
            .unwrap();
        assert_eq!(wait(&mut child).code(), Some(1));
        for role in ["model", "relay", "telemetry", "website"] {
            let path = fixture.0.join(format!("{role}.pid"));
            if let Ok(pid) = fs::read_to_string(path) {
                assert!(kill(Pid::from_raw(pid.parse().unwrap()), None).is_err());
            }
        }
    }
}

#[test]
fn model_disabled_needs_no_llama_binary_or_model_credentials() {
    let fixture = Fixture::new();
    let mut child = fixture.command(false).spawn().unwrap();
    fixture.ready("website");
    terminate(&mut child);
    assert!(!fixture.0.join("model.pid").exists());
    assert!(!fixture.0.join("relay.pid").exists());
    assert!(!fixture.0.join("runtime").exists());
}

#[test]
fn invalid_model_configuration_is_refused_before_any_child_starts() {
    for (variable, value) in [
        ("REVERIE_LOCAL_MODEL_ALIAS", "name\n[another]"),
        ("REVERIE_LOCAL_MODEL_CACHE_TYPE", "invalid"),
    ] {
        let fixture = Fixture::new();
        let result = fixture.command(true).env(variable, value).output().unwrap();
        assert!(!result.status.success());
        assert!(!fixture.0.join("website.pid").exists());
        assert!(!fixture.0.join("model.pid").exists());
        assert!(!fixture.0.join("runtime").exists());
    }
}
