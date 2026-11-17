#![cfg(feature = "test-fixtures")]
use serde_json::Value;
use std::{
    fs::{self, DirBuilder, Permissions},
    os::unix::fs::{DirBuilderExt, PermissionsExt, symlink},
    path::{Path, PathBuf},
    process::{Command, Output},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const GOOD: &str = "RTX 3090, 27, 754, 24576";
struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        let mut random = [0; 8];
        getrandom::getrandom(&mut random).unwrap();
        let name = format!("reverie-gpu-publisher-{:016x}", u64::from_be_bytes(random));
        let path = std::env::temp_dir().join(name);
        DirBuilder::new().mode(0o700).create(&path).unwrap();
        let fixture = Self(path);
        fs::copy(
            env!("CARGO_BIN_EXE_reverie-container-fixture"),
            fixture.provider(),
        )
        .unwrap();
        fixture.csv(GOOD);
        fixture
    }

    fn provider(&self) -> PathBuf {
        self.0.join("nvidia-smi")
    }

    fn csv(&self, output: &str) {
        fs::write(self.provider().with_extension("csv"), output).unwrap();
    }

    fn command(&self) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_reverie-gpu-publisher"));
        command
            .env_clear()
            .env("NVIDIA_SMI", self.provider())
            .env("PATH", &self.0);
        command
    }

    fn output_path(&self) -> PathBuf {
        self.0.join("telemetry/gpu.json")
    }

    fn read(path: &Path) -> Value {
        serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
    }

    fn publish(&self) -> Output {
        self.command()
            .arg("--once")
            .arg("--output")
            .arg(self.output_path())
            .output()
            .unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

fn successful(output: Output) {
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn display_contract_discovers_the_provider_and_publishes_multiple_devices() {
    let fixture = Fixture::new();
    fixture.csv(&format!("{GOOD}\nA100, PCIe 40GB, 90.5, 1000, 40000\n"));
    let start = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis();
    successful(
        fixture
            .command()
            .env_remove("NVIDIA_SMI")
            .arg("--once")
            .arg("--output")
            .arg(fixture.output_path())
            .output()
            .unwrap(),
    );
    let output = fixture.output_path();
    assert_eq!(
        fs::metadata(&output).unwrap().permissions().mode() & 0o777,
        0o644
    );
    let reading = Fixture::read(&output);
    assert!(u128::from(reading["updatedAt"].as_u64().unwrap()) >= start);
    let gpus = reading["gpus"].as_array().unwrap();
    assert_eq!(gpus.len(), 2);
    assert_eq!(gpus[0]["name"], "RTX 3090");
    assert_eq!(gpus[0]["utilization"].as_f64(), Some(27.0));
    assert_eq!(gpus[0]["memoryUsedMb"].as_f64(), Some(754.0));
    assert_eq!(gpus[0]["memoryTotalMb"].as_f64(), Some(24576.0));
    assert_eq!(gpus[1]["name"], "A100, PCIe 40GB");
    assert_eq!(gpus[1]["utilization"].as_f64(), Some(90.5));
    assert_eq!(
        fs::read_dir(fixture.output_path().parent().unwrap())
            .unwrap()
            .count(),
        1
    );
}

#[test]
fn unavailable_or_excessive_readings_clear_the_container_file() {
    let fixture = Fixture::new();
    for bad in [
        "".to_owned(),
        "X, 101, 1, 2".to_owned(),
        "X, 5, 9, 8".to_owned(),
        "X, 5, 1, 0".to_owned(),
        "X, -5, 1, 4".to_owned(),
        "X, 5, 1e1, 10".to_owned(),
        "X, 5, 1, Infinity".to_owned(),
        "X, N/A, 1, 4".to_owned(),
        format!("{GOOD}\n{}", "X, 1, 1, 4\n".repeat(64)),
        "X".repeat(70 * 1024),
    ] {
        fixture.csv(GOOD);
        successful(fixture.publish());
        fixture.csv(&bad);
        successful(fixture.publish());
        assert!(!fixture.output_path().exists());
    }
    fixture.csv(GOOD);
    successful(fixture.publish());
    fs::write(fixture.provider().with_extension("fail"), "").unwrap();
    successful(fixture.publish());
    assert!(!fixture.output_path().exists());
}

#[test]
fn a_hung_driver_has_a_bounded_runtime_and_clears_the_reading() {
    let fixture = Fixture::new();
    successful(fixture.publish());
    fs::write(fixture.provider().with_extension("hang"), "").unwrap();
    let start = Instant::now();
    successful(fixture.publish());
    assert!(start.elapsed() < Duration::from_secs(8));
    assert!(!fixture.output_path().exists());
}

#[test]
fn publication_replaces_leaf_links_and_refuses_unsafe_parents() {
    let fixture = Fixture::new();
    let victim = fixture.0.join("victim");
    fs::write(&victim, "keep").unwrap();
    let output = fixture.output_path();
    let parent = output.parent().unwrap();
    fs::create_dir(parent).unwrap();
    symlink(&victim, &output).unwrap();
    successful(fixture.publish());
    assert_eq!(fs::read_to_string(victim).unwrap(), "keep");
    assert!(!output.is_symlink());
    fs::remove_file(&output).unwrap();
    fs::create_dir(&output).unwrap();
    assert_eq!(fixture.publish().status.code(), Some(1));
    assert_eq!(fs::read_dir(parent).unwrap().count(), 1);
    let moved = fixture.0.join("elsewhere");
    fs::rename(parent, &moved).unwrap();
    symlink(&moved, parent).unwrap();
    assert!(!fixture.publish().status.success());
    assert_eq!(fs::read_dir(moved).unwrap().count(), 1);
}

#[test]
fn refuses_publication_to_a_writable_shared_directory() {
    let fixture = Fixture::new();
    let output = fixture.output_path();
    let parent = output.parent().unwrap();
    fs::create_dir(parent).unwrap();
    fs::set_permissions(parent, Permissions::from_mode(0o777)).unwrap();

    assert_eq!(fixture.publish().status.code(), Some(2));
    assert!(!output.exists());
}
