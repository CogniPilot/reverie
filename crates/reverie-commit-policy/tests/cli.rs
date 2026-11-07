//! The command against a real staged repository, mirroring the reference's command tests.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT: AtomicU64 = AtomicU64::new(0);

/// A git repository at `<root>/repo` and unstaged input files at `<root>/files`.
struct Repo(PathBuf);

impl Repo {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "reverie-commit-policy-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(path.join("repo")).expect("owned repository directory");
        fs::create_dir_all(path.join("files")).expect("owned input directory");
        let repo = Self(path);
        repo.git(&["init", "-q"]);
        repo.write("old.py", "# kept: Alpha wrote this long ago\nvalue = 1\n");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-q", "-m", "base"]);
        repo
    }

    fn git(&self, arguments: &[&str]) {
        let status = Command::new("git")
            .args([
                "-c",
                "user.name=Test Person",
                "-c",
                "user.email=test@example.org",
            ])
            .args(["-c", "commit.gpgsign=false", "-C"])
            .arg(self.dir())
            .args(arguments)
            .status()
            .expect("git");
        assert!(status.success(), "git {arguments:?}");
    }

    fn dir(&self) -> PathBuf {
        self.0.join("repo")
    }

    fn write(&self, name: &str, text: &str) -> PathBuf {
        let path = self.dir().join(name);
        fs::create_dir_all(path.parent().expect("parent")).expect("parents");
        fs::write(&path, text).expect("write");
        path
    }

    fn input(&self, name: &str, text: &str) -> PathBuf {
        let path = self.0.join("files").join(name);
        fs::write(&path, text).expect("write input");
        path
    }

    fn stage(&self, name: &str, text: &str) {
        self.write(name, text);
        self.git(&["add", "-A"]);
    }
}

impl Drop for Repo {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).expect("remove only this owned repository");
    }
}

const POLICY: &str = r#"{"agent_anonymity": {"agent_names": ["Alpha", "Bravo", "Sentinel"], "allow_paths": ["vendor/*"]}}"#;

fn run(policy: &Path, arguments: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_reverie-commit-policy"))
        .arg("--policy")
        .arg(policy)
        .args(arguments)
        .env_remove("REVERIE_AGENT_ID")
        .output()
        .expect("run the command")
}

fn stdout(output: &Output) -> String {
    String::from_utf8(output.stdout.clone()).expect("utf-8 output")
}

#[test]
fn check_commit_blocks_names_and_passes_clean_changes() {
    let repo = Repo::new();
    let policy = repo.input("policy.json", POLICY);
    let receipt = repo.input("receipt.json", "{}");
    let clean = repo.input("clean.txt", "Restart cleanly\n");
    let named = repo.input("named.txt", "Alpha: restart cleanly\n");
    let dir = repo.dir();
    let base = [
        "check-commit",
        "--repo",
        dir.to_str().expect("path"),
        "--receipt",
        receipt.to_str().expect("path"),
    ];
    repo.stage("new.py", "def restart():\n    return 'coordinator'\n");
    let ok = run(
        &policy,
        &[
            &base[..],
            &["--message-file", clean.to_str().expect("path")],
        ]
        .concat(),
    );
    assert!(
        ok.status.success(),
        "{}",
        String::from_utf8_lossy(&ok.stderr)
    );
    assert!(
        stdout(&ok).starts_with("{\"allowed\": true, \"tree\": \""),
        "{}",
        stdout(&ok)
    );
    let refused = run(
        &policy,
        &[
            &base[..],
            &["--message-file", named.to_str().expect("path")],
        ]
        .concat(),
    );
    assert_eq!(refused.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&refused.stderr).contains("agent_anonymity): message:1 Alpha"));
    repo.stage("tests/test_x.py", "SESSION_NAME = 'Sentinel'\n");
    let staged = run(
        &policy,
        &[
            &base[..],
            &["--message-file", clean.to_str().expect("path")],
        ]
        .concat(),
    );
    assert_eq!(staged.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&staged.stderr).contains("tests/test_x.py:1 Sentinel"));
    let off = repo.input("off.json", "{}");
    let unchecked = run(
        &off,
        &[
            &base[..],
            &["--message-file", named.to_str().expect("path")],
        ]
        .concat(),
    );
    assert!(unchecked.status.success());
}

#[test]
fn check_anonymity_exit_codes_and_output() {
    let repo = Repo::new();
    let policy = repo.input("policy.json", POLICY);
    let text = repo.input("pr.md", "Reviewed by Bravo\n");
    let found = run(
        &policy,
        &[
            "check-anonymity",
            "--text-file",
            text.to_str().expect("path"),
        ],
    );
    assert_eq!(found.status.code(), Some(1));
    assert_eq!(
        stdout(&found),
        "{\"allowed\": false, \"violations\": [{\"where\": \"message\", \"line\": 1, \"name\": \"Bravo\"}]}\n"
    );
    fs::write(&text, "Reviewed by the project\n").expect("rewrite");
    let clean = run(
        &policy,
        &[
            "check-anonymity",
            "--text-file",
            text.to_str().expect("path"),
            "--staged",
            repo.dir().to_str().expect("path"),
        ],
    );
    assert!(clean.status.success());
    assert_eq!(stdout(&clean), "{\"allowed\": true, \"violations\": []}\n");
}

#[test]
fn a_policy_that_is_not_an_object_is_refused() {
    let repo = Repo::new();
    let policy = repo.input("policy.json", "[]");
    let output = run(&policy, &["review-context"]);
    assert_eq!(output.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&output.stderr).contains("standing policy must be an object"));
}
