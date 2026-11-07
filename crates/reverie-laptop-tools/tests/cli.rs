use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
#[path = "support/autoenv_cases.rs"]
mod autoenv_cases;
#[path = "support/autoenv_fixture.rs"]
mod autoenv_fixture;

static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture {
    root: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "reverie-laptop-cli-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        Self { root }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root).unwrap();
    }
}
#[test]
fn direct_jobs_cli_always_prints_a_positive_default_even_with_owner_override() {
    let output = Command::new(env!("CARGO_BIN_EXE_reverie-build-jobs"))
        .env("CARGO_BUILD_JOBS", "777")
        .output()
        .unwrap();
    assert!(output.status.success());
    assert!(
        std::str::from_utf8(&output.stdout)
            .unwrap()
            .trim()
            .parse::<usize>()
            .unwrap()
            > 0
    );
}
#[test]
fn cargo_defaults_cli_changes_only_the_selected_owned_home() {
    let fixture = Fixture::new();
    let run = || {
        Command::new(env!("CARGO_BIN_EXE_reverie-cargo-defaults"))
            .env("HOME", &fixture.root)
            .output()
            .unwrap()
    };
    let output = run();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(fixture.root.join(".cargo/config.toml").exists());
    let output = run();
    assert!(output.status.success());
    assert!(String::from_utf8_lossy(&output.stdout).contains("preserved existing build-dir"));
}
#[test]
fn help_and_invalid_arguments_never_create_or_change_a_home() {
    for binary in [
        env!("CARGO_BIN_EXE_reverie-build-jobs"),
        env!("CARGO_BIN_EXE_reverie-cargo-defaults"),
        env!("CARGO_BIN_EXE_reverie-autoenv"),
    ] {
        let fixture = Fixture::new();
        for (argument, status) in [("--help", 0), ("--unsupported", 2)] {
            let output = Command::new(binary)
                .arg(argument)
                .env("HOME", &fixture.root)
                .output()
                .unwrap();
            assert_eq!(output.status.code(), Some(status));
            assert_eq!(fs::read_dir(&fixture.root).unwrap().count(), 0);
        }
    }
}
fn shim_case(
    arguments: &[&str],
    owner_jobs: Option<&str>,
    disabled: bool,
    called: bool,
    expected: Option<&str>,
) {
    let fixture = autoenv_fixture::Fixture::new();
    let shim = fixture.shim.join("cargo");
    let marker = fixture.root.join("helper-called");
    let mut command = fixture.command(shim);
    command
        .args(arguments)
        .env("IN_NIX_SHELL", "1")
        .env_remove("CARGO_BUILD_JOBS")
        .env_remove("REVERIE_NO_AUTOENV");
    if let Some(jobs) = owner_jobs {
        command.env("CARGO_BUILD_JOBS", jobs);
    }
    if disabled {
        command.env("REVERIE_NO_AUTOENV", "1");
    }
    let output = command.output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(marker.exists(), called);
    let jobs = autoenv_fixture::Fixture::values(&output)["CARGO_BUILD_JOBS"].clone();
    if let Some(expected) = expected {
        assert_eq!(jobs, expected);
    } else {
        assert!(jobs.parse::<usize>().unwrap() > 0);
    }
}
#[test]
fn launcher_shim_preserves_explicit_job_arguments_values_and_reviewed_opt_out() {
    for arguments in [
        vec!["build", "-j", "3"],
        vec!["build", "-j8"],
        vec!["build", "--jobs", "4"],
        vec!["build", "--jobs=5"],
    ] {
        shim_case(&arguments, None, false, false, Some("<unset>"));
    }
    shim_case(&["build"], Some("7"), false, false, Some("7"));
    shim_case(&["build"], None, true, false, Some("<unset>"));
    shim_case(&["build"], None, false, true, None);
}
