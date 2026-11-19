#![cfg(feature = "test-fixtures")]
//! Start the real entrypoint with a PATH that contains no interpreter.
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::{Value, json};
use std::env;
use std::fs;
use std::os::unix::fs::{DirBuilderExt, PermissionsExt, symlink};
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

const FIXTURE: &str = env!("CARGO_BIN_EXE_reverie-container-fixture");

struct Root(PathBuf);

impl Root {
    fn new() -> Self {
        let mut random = [0; 12];
        getrandom::getrandom(&mut random).unwrap();
        let path = env::temp_dir().join(format!("reverie-boot-{}", URL_SAFE_NO_PAD.encode(random)));
        fs::DirBuilder::new().mode(0o700).create(&path).unwrap();
        fs::create_dir(path.join("bin")).unwrap();
        for alias in [
            "reverie",
            "reverie-kokoro",
            "reverie-speech",
            "reverie-install-clis",
            "codex",
        ] {
            symlink(FIXTURE, path.join("bin").join(alias)).unwrap();
        }
        Self(path)
    }

    fn data(&self) -> PathBuf {
        self.0.join("instances/default")
    }

    fn command(&self) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_reverie-container-start"));
        command
            .env_clear()
            .env("PATH", self.0.join("bin"))
            .env("HOME", &self.0)
            .env("TMPDIR", self.0.join("scratch/tmp"))
            .env("REVERIE_DATA", self.data())
            .env("REVERIE_BOOT_FIXTURE", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        command
    }
}

impl Drop for Root {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

fn succeeded(output: Output) -> Output {
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    output
}

fn mode(path: &Path) -> u32 {
    fs::metadata(path).unwrap().permissions().mode() & 0o777
}

fn real_tool(name: &str) -> PathBuf {
    env::split_paths(&env::var_os("PATH").unwrap())
        .map(|directory| directory.join(name))
        .find(|candidate| candidate.is_file())
        .unwrap_or_else(|| panic!("{name} missing from the development environment"))
}

#[test]
fn fresh_start_and_recreate_preserve_private_credential_and_owner_state() {
    let root = Root::new();
    let data = root.data();
    let console = data.join("console");
    let output = succeeded(root.command().output().unwrap());
    let value: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        value["argv"],
        json!(["web", "--host", "0.0.0.0", "--port", "3000"])
    );
    assert_eq!(value["console"], json!(console));
    assert_eq!(value["username"], "owner");
    assert_eq!(value["credentialLength"], 24);
    assert_eq!(value["setup"], "1");
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(stderr.contains("synthetic provider installation unavailable"));
    assert!(stderr.contains("synthetic Kokoro started"));
    let secret = data.join("owner-password");
    let password = fs::read_to_string(&secret).unwrap();
    assert_eq!(mode(&secret), 0o600);
    assert_eq!(URL_SAFE_NO_PAD.decode(password.trim()).unwrap().len(), 18);
    assert!(!stderr.contains(password.trim()));
    assert!(
        !String::from_utf8(output.stdout)
            .unwrap()
            .contains(password.trim())
    );
    assert!(root.0.join("scratch/tmp").is_dir());
    for name in ["claude", "codex"] {
        let profile = data.join("accounts").join(name);
        assert_eq!(value[name], json!(profile));
        assert_eq!(mode(&profile), 0o700);
    }
    let account = console.join("owner-auth.json");
    let marker = console.join("owner-auth.policy");
    assert!(!account.exists());
    assert!(!marker.exists());
    fs::write(&account, "{}").unwrap();
    let missing = root.0.join("missing-owner-policy");
    symlink(&missing, &marker).unwrap();
    let restarted = succeeded(root.command().output().unwrap());
    assert_eq!(fs::read_to_string(secret).unwrap(), password);
    assert_eq!(fs::read_to_string(account).unwrap(), "{}");
    assert_eq!(fs::read_link(marker).unwrap(), missing);
    assert!(!missing.exists());
    assert!(
        !String::from_utf8(restarted.stderr)
            .unwrap()
            .contains("credential created")
    );
    assert_eq!(fs::read_dir(data.join("backups")).unwrap().count(), 0);
}

#[test]
fn supplied_values_and_explicit_command_are_preserved() {
    let root = Root::new();
    let console = root.0.join("custom instance/nested/data");
    let output = succeeded(
        root.command()
            .arg("reverie")
            .arg("--version")
            .env("REVERIE_DATA_DIR", &console)
            .env("REVERIE_PASSWORD", "chosen")
            .env("CLAUDE_CONFIG_DIR", "/elsewhere/claude")
            .env("CODEX_HOME", "/elsewhere/codex")
            .output()
            .unwrap(),
    );
    let value: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["argv"], json!(["--version"]));
    assert_eq!(value["console"], json!(console));
    assert_eq!(value["claude"], "/elsewhere/claude");
    assert_eq!(value["codex"], "/elsewhere/codex");
    assert_eq!(value["credentialLength"], 6);
    assert_eq!(mode(&console), 0o700);
    assert_eq!(mode(&console.join(".env")), 0o600);
    assert_eq!(
        fs::read_to_string(console.join(".env")).unwrap(),
        "REVERIE_USERNAME=owner\nREVERIE_PASSWORD=chosen\n"
    );
    assert_eq!(fs::read_dir(&console).unwrap().count(), 1);
    assert!(!root.data().join("owner-password").exists());
    assert!(
        !String::from_utf8(output.stderr)
            .unwrap()
            .contains("synthetic Kokoro started")
    );
}

#[test]
fn startup_respects_optional_service_settings_and_provider_precedence() {
    let root = Root::new();
    for (name, value) in [
        ("REVERIE_KOKORO_ENABLED", "0"),
        ("REVERIE_KOKORO_URL", "http://operator-service:8091"),
    ] {
        let output = succeeded(root.command().env(name, value).output().unwrap());
        assert!(
            !String::from_utf8(output.stderr)
                .unwrap()
                .contains("synthetic Kokoro started")
        );
    }
    let mutable_bin = root.data().join("tools/bin");
    fs::create_dir(&mutable_bin).unwrap();
    symlink(real_tool("false"), mutable_bin.join("codex")).unwrap();
    let output = succeeded(root.command().arg("codex").output().unwrap());
    assert_eq!(output.stdout, b"managed-provider-guard\n");
    let absent = root
        .command()
        .arg("explicitly-missing-command")
        .output()
        .unwrap();
    assert_eq!(absent.status.code(), Some(127));
}

#[test]
fn concurrent_first_starts_publish_one_credential() {
    let root = Root::new();
    let first = root.command().spawn().unwrap();
    let second = succeeded(root.command().output().unwrap());
    let first = succeeded(first.wait_with_output().unwrap());
    let generated = [first.stderr, second.stderr]
        .iter()
        .filter(|log| String::from_utf8_lossy(log).contains("credential created"))
        .count();
    assert_eq!(generated, 1);
    let data = root.data();
    let password = fs::read_to_string(data.join("owner-password")).unwrap();
    let dotenv = fs::read_to_string(data.join("console/.env")).unwrap();
    assert_eq!(
        dotenv,
        format!("REVERIE_USERNAME=owner\nREVERIE_PASSWORD={password}")
    );
}

#[test]
fn refuses_linked_bootstrap_credential_without_changing_its_target() {
    let root = Root::new();
    let data = root.data();
    fs::create_dir_all(&data).unwrap();
    let target = root.0.join("foreign");
    fs::write(&target, "unrelated").unwrap();
    let password = data.join("owner-password");
    symlink(&target, &password).unwrap();
    let output = root.command().output().unwrap();
    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty());
    assert_eq!(fs::read_link(password).unwrap(), target);
    assert_eq!(fs::read_to_string(target).unwrap(), "unrelated");
    assert!(!data.join("console/.env").exists());
}

#[test]
fn upgrade_failure_retries_before_advancing_the_version_or_replacing_state() {
    let root = Root::new();
    let data = root.data();
    let old = "v0.1.0";
    let new = "v0.1.1";
    succeeded(root.command().env("REVERIE_VERSION", old).output().unwrap());
    fs::write(data.join("console/state.json"), "{\"kept\":true}").unwrap();
    let alias = root.0.join("bin/tar");
    symlink(FIXTURE, &alias).unwrap();
    let refused = root.command().env("REVERIE_VERSION", new).output().unwrap();
    assert_eq!(refused.status.code(), Some(1));
    assert!(refused.stdout.is_empty());
    assert_eq!(
        fs::read_to_string(data.join(".image-version"))
            .unwrap()
            .trim(),
        old
    );
    let backups = data.join("backups");
    assert_eq!(fs::read_dir(&backups).unwrap().count(), 0);
    fs::remove_file(&alias).unwrap();
    let tar = real_tool("tar");
    symlink(&tar, alias).unwrap();
    for _ in 0..2 {
        succeeded(root.command().env("REVERIE_VERSION", new).output().unwrap());
    }
    assert_eq!(
        fs::read_to_string(data.join(".image-version"))
            .unwrap()
            .trim(),
        new
    );
    let mut entries = fs::read_dir(backups).unwrap();
    let archive = entries.next().unwrap().unwrap().path();
    assert!(entries.next().is_none());
    assert!(
        archive
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("console-v0.1.0-")
    );
    let listing = succeeded(Command::new(tar).arg("-tf").arg(archive).output().unwrap());
    let names = String::from_utf8(listing.stdout).unwrap();
    assert!(names.contains("console/state.json"));
    assert!(!names.contains("owner-auth.policy"));
}

#[test]
fn speech_starts_only_for_the_opted_in_local_web_service() {
    let root = Root::new();
    let started = |output: Output| {
        String::from_utf8(succeeded(output).stderr)
            .unwrap()
            .contains("synthetic speech started")
    };
    assert!(!started(root.command().output().unwrap()));
    assert!(started(
        root.command()
            .env("REVERIE_VOICE_ENABLED", "1")
            .output()
            .unwrap()
    ));
    assert!(!started(
        root.command()
            .env("REVERIE_VOICE_ENABLED", "1")
            .env("REVERIE_VOICE_TURN_URL", "http://operator-service:8090")
            .output()
            .unwrap()
    ));
    assert!(!started(
        root.command()
            .env("REVERIE_VOICE_ENABLED", "1")
            .args(["reverie", "--version"])
            .output()
            .unwrap()
    ));
}
