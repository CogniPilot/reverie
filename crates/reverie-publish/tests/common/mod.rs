//! Shared fixtures: throwaway repositories, sealed packets, approval records and a name list of
//! invented words. Each test binary uses part of it.
#![allow(dead_code)]
use reverie_publish::sha256_hex;
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Output},
};

pub(crate) const JAMES_NAME: &str = "James Goppert";
pub(crate) const JAMES_EMAIL: &str = "jgoppert@users.noreply.github.com";
pub(crate) const SIGNOFF: &str = "Signed-off-by: James Goppert <jgoppert@users.noreply.github.com>";

/// Invented entries only: the gate must block them without any real name in the repository.
pub(crate) const LISTS: &str = r#"{"schema":1,"home_repo":"demo","team":["zorblat"],"internal":["quuxhost"],"ai_words":["robotronix"],"ai_phrases":["made by a machine"],"path_markers":["/opt/hidden-zone/"],"allow":["harmless"]}"#;

pub(crate) struct Fixture {
    pub(crate) root: PathBuf,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

pub(crate) fn git(dir: &Path, args: &[&str]) -> String {
    git_as(dir, args, JAMES_NAME, JAMES_EMAIL)
}

pub(crate) fn git_as(dir: &Path, args: &[&str], name: &str, email: &str) -> String {
    let out = Command::new("git")
        .args([
            "-c",
            "init.defaultBranch=main",
            "-c",
            "commit.gpgsign=false",
        ])
        .args(args)
        .current_dir(dir)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_AUTHOR_NAME", name)
        .env("GIT_AUTHOR_EMAIL", email)
        .env("GIT_COMMITTER_NAME", name)
        .env("GIT_COMMITTER_EMAIL", email)
        .env("GIT_AUTHOR_DATE", "2026-01-01T00:00:00Z")
        .env("GIT_COMMITTER_DATE", "2026-01-01T00:00:00Z")
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_owned()
}

impl Fixture {
    /// A work repo with `main` (one file) and a store holding only `main`.
    pub(crate) fn new(name: &str) -> Self {
        let root =
            std::env::temp_dir().join(format!("publish-check-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        for dir in ["work", "packet"] {
            fs::create_dir_all(root.join(dir)).unwrap();
        }
        let work = root.join("work");
        git(&work, &["init", "-q"]);
        fs::write(work.join("a.txt"), "one\n").unwrap();
        git(&work, &["add", "a.txt"]);
        git(
            &work,
            &["commit", "-q", "-m", &format!("Base\n\n{SIGNOFF}")],
        );
        git(&root, &["init", "-q", "--bare", "store.git"]);
        git(
            &root.join("store.git"),
            &[
                "fetch",
                "-q",
                work.to_str().unwrap(),
                "main:refs/heads/main",
            ],
        );
        fs::write(root.join("lists.json"), LISTS).unwrap();
        Self { root }
    }

    pub(crate) fn work(&self) -> PathBuf {
        self.root.join("work")
    }

    /// Commits `content` to `file` on a branch `topic` with `message` and returns the head.
    pub(crate) fn commit(&self, file: &str, content: &str, message: &str) -> String {
        let work = self.work();
        let _ = Command::new("git")
            .args(["checkout", "-q", "-B", "topic"])
            .current_dir(&work)
            .status();
        fs::write(work.join(file), content).unwrap();
        git(&work, &["add", file]);
        git(&work, &["commit", "-q", "-m", message]);
        git(&work, &["rev-parse", "HEAD"])
    }

    /// Writes the packet (bundle, title, body, extra files) and seals it.
    pub(crate) fn seal(&self, title: &str, body: &str) -> String {
        let packet = self.root.join("packet");
        git(
            &self.work(),
            &[
                "bundle",
                "create",
                "-q",
                packet.join("source.bundle").to_str().unwrap(),
                "main..topic",
            ],
        );
        fs::write(packet.join("TITLE.txt"), format!("{title}\n")).unwrap();
        fs::write(packet.join("BODY.md"), body).unwrap();
        self.reseal()
    }

    pub(crate) fn reseal(&self) -> String {
        let packet = self.root.join("packet");
        let mut names: Vec<String> = fs::read_dir(&packet)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .filter(|n| n != "SHA256SUMS")
            .collect();
        names.sort();
        let sums: String = names
            .iter()
            .map(|n| format!("{}  {n}\n", sha256_hex(&fs::read(packet.join(n)).unwrap())))
            .collect();
        fs::write(packet.join("SHA256SUMS"), &sums).unwrap();
        sha256_hex(sums.as_bytes())[..8].to_owned()
    }

    pub(crate) fn check(&self, seal: &str, head: &str, extra: &[&str]) -> Output {
        self.check_env(seal, head, extra, &[])
    }

    pub(crate) fn check_env(
        &self,
        seal: &str,
        head: &str,
        extra: &[&str],
        envs: &[(&str, &str)],
    ) -> Output {
        self.command(seal, head, extra)
            .envs(envs.iter().copied())
            .output()
            .unwrap()
    }

    /// The check command against this fixture's packet, store and lists.
    pub(crate) fn command(&self, seal: &str, head: &str, extra: &[&str]) -> Command {
        let (packet, store) = (self.root.join("packet"), self.root.join("store.git"));
        let mut command = self.command_at(seal, head, &packet, &store);
        command.args(extra);
        command
    }

    pub(crate) fn command_at(
        &self,
        seal: &str,
        head: &str,
        packet: &Path,
        store: &Path,
    ) -> Command {
        let tree = git(&self.work(), &["rev-parse", &format!("{head}^{{tree}}")]);
        let lists_sha = sha256_hex(LISTS.as_bytes());
        let root = &self.root;
        let mut command = Command::new(env!("CARGO_BIN_EXE_reverie-publish"));
        command
            .args([
                "check",
                "--repo",
                "owner/demo",
                "--base",
                "refs/heads/main",
                "--head",
                head,
                "--seal",
                seal,
            ])
            .args(["--tree", &tree[..12], "--lists-sha256", &lists_sha])
            .arg("--packet")
            .arg(packet)
            .arg("--git-dir")
            .arg(store)
            .arg("--lists")
            .arg(root.join("lists.json"));
        command
    }

    /// Bundle copies left in the store.
    pub(crate) fn copies(&self) -> Vec<String> {
        fs::read_dir(self.root.join("store.git"))
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .filter(|n| n.starts_with("publish-packet-"))
            .collect()
    }
}

pub(crate) fn stderr(out: &Output) -> String {
    String::from_utf8_lossy(&out.stderr).into_owned()
}

pub(crate) fn refused(out: &Output, why: &str) {
    assert_eq!(
        out.status.code(),
        Some(1),
        "expected a refusal: {}",
        stderr(out)
    );
    assert!(
        stderr(out).contains(why),
        "expected {why:?} in: {}",
        stderr(out)
    );
}

impl Fixture {
    /// An approval record for `head` against `base`, covering `title` and `body`.
    pub(crate) fn approval(
        &self,
        head: &str,
        base: &str,
        title: &str,
        body: &str,
    ) -> serde_json::Value {
        let work = self.work();
        let bytes = |args: &[&str]| {
            Command::new("git")
                .args(args)
                .current_dir(&work)
                .output()
                .unwrap()
                .stdout
        };
        serde_json::json!({
            "publicationAuthorized": true,
            "repo": "owner/demo",
            "head": head,
            "tree": git(&work, &["rev-parse", &format!("{head}^{{tree}}")]),
            "rawCommitSha256": sha256_hex(&bytes(&["cat-file", "commit", head])),
            "base": git(&work, &["rev-parse", base]),
            "patchSha256": sha256_hex(&bytes(&["diff", "--binary", "--full-index", base, head])),
            "titleSha256": sha256_hex(title.as_bytes()),
            "bodySha256": sha256_hex(body.as_bytes()),
            "reviews": ["source GO 0000aaaa"],
        })
    }

    pub(crate) fn with_approval(&self, approval: &serde_json::Value) -> String {
        let path = self.root.join("approval.json");
        fs::write(&path, approval.to_string()).unwrap();
        path.to_string_lossy().into_owned()
    }
}
