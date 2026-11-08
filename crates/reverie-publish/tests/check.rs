//! The real `reverie-publish check` against throwaway repositories, packets and a fixture name
//! list of invented words.
use reverie_publish::sha256_hex;
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Output},
};

const JAMES_NAME: &str = "James Goppert";
const JAMES_EMAIL: &str = "jgoppert@users.noreply.github.com";
const SIGNOFF: &str = "Signed-off-by: James Goppert <jgoppert@users.noreply.github.com>";

/// Invented entries only: the gate must block them without any real name in the repository.
const LISTS: &str = r#"{"schema":1,"home_repo":"demo","team":["zorblat"],"internal":["quuxhost"],"ai_words":["robotronix"],"ai_phrases":["made by a machine"],"path_markers":["/opt/hidden-zone/"],"allow":["harmless"]}"#;

struct Fixture {
    root: PathBuf,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn git(dir: &Path, args: &[&str]) -> String {
    git_as(dir, args, JAMES_NAME, JAMES_EMAIL)
}

fn git_as(dir: &Path, args: &[&str], name: &str, email: &str) -> String {
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
    fn new(name: &str) -> Self {
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

    fn work(&self) -> PathBuf {
        self.root.join("work")
    }

    /// Commits `content` to `file` on a branch `topic` with `message` and returns the head.
    fn commit(&self, file: &str, content: &str, message: &str) -> String {
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
    fn seal(&self, title: &str, body: &str) -> String {
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

    fn reseal(&self) -> String {
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

    fn check(&self, seal: &str, head: &str, extra: &[&str]) -> Output {
        let tree = git(&self.work(), &["rev-parse", &format!("{head}^{{tree}}")]);
        let lists_sha = sha256_hex(LISTS.as_bytes());
        let root = &self.root;
        Command::new(env!("CARGO_BIN_EXE_reverie-publish"))
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
            .arg(root.join("packet"))
            .arg("--git-dir")
            .arg(root.join("store.git"))
            .arg("--lists")
            .arg(root.join("lists.json"))
            .args(extra)
            .output()
            .unwrap()
    }
}

fn stderr(out: &Output) -> String {
    String::from_utf8_lossy(&out.stderr).into_owned()
}

fn refused(out: &Output, why: &str) {
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

#[test]
fn a_clean_packet_passes_every_check() {
    let f = Fixture::new("clean");
    let head = f.commit("b.txt", "two\n", &format!("Add b\n\n{SIGNOFF}"));
    let seal = f.seal("Add b", "Adds b.\n");
    let out = f.check(&seal, &head, &[]);
    assert_eq!(out.status.code(), Some(0), "{}", stderr(&out));
    let summary: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(summary["verified"], true);
    assert_eq!(summary["commits"], 1);
    assert_eq!(summary["title"], "Add b");
}

#[test]
fn a_wrong_seal_or_an_unlisted_file_refuses() {
    let f = Fixture::new("seal");
    let head = f.commit("b.txt", "two\n", &format!("Add b\n\n{SIGNOFF}"));
    let seal = f.seal("Add b", "Adds b.\n");
    refused(&f.check("00000000", &head, &[]), "packet seal");
    fs::write(f.root.join("packet/NOTES.txt"), "late addition\n").unwrap();
    refused(
        &f.check(&seal, &head, &[]),
        "files not in SHA256SUMS: NOTES.txt",
    );
}

#[test]
fn a_file_changed_after_sealing_refuses() {
    let f = Fixture::new("tamper");
    let head = f.commit("b.txt", "two\n", &format!("Add b\n\n{SIGNOFF}"));
    let seal = f.seal("Add b", "Adds b.\n");
    fs::write(f.root.join("packet/BODY.md"), "Edited after review.\n").unwrap();
    refused(&f.check(&seal, &head, &[]), "BODY.md: hash does not match");
}

#[test]
fn a_missing_signoff_or_a_foreign_author_refuses() {
    let f = Fixture::new("ident");
    let head = f.commit("b.txt", "two\n", "Add b without a sign-off");
    let seal = f.seal("Add b", "Adds b.\n");
    refused(&f.check(&seal, &head, &[]), "no Signed-off-by");

    let g = Fixture::new("foreign");
    let work = g.work();
    let _ = Command::new("git")
        .args(["checkout", "-q", "-B", "topic"])
        .current_dir(&work)
        .status();
    fs::write(work.join("b.txt"), "two\n").unwrap();
    git(&work, &["add", "b.txt"]);
    git_as(
        &work,
        &["commit", "-q", "-m", &format!("Add b\n\n{SIGNOFF}")],
        "Someone Else",
        "else@example.invalid",
    );
    let head = git(&work, &["rev-parse", "HEAD"]);
    let seal = g.seal("Add b", "Adds b.\n");
    refused(
        &g.check(&seal, &head, &[]),
        "author is not an allowed identity",
    );
}

#[test]
fn a_blocking_name_in_added_lines_a_message_or_the_body_refuses() {
    let f = Fixture::new("code");
    let head = f.commit("b.txt", "ask Zorblat\n", &format!("Add b\n\n{SIGNOFF}"));
    let seal = f.seal("Add b", "Adds b.\n");
    refused(
        &f.check(&seal, &head, &[]),
        "added lines has blocking names (team)",
    );

    let g = Fixture::new("message");
    let head = g.commit("b.txt", "two\n", &format!("Add b for Zorblat\n\n{SIGNOFF}"));
    let seal = g.seal("Add b", "Adds b.\n");
    refused(
        &g.check(&seal, &head, &[]),
        "message has blocking names (team)",
    );

    let h = Fixture::new("body");
    let head = h.commit("b.txt", "two\n", &format!("Add b\n\n{SIGNOFF}"));
    let seal = h.seal("Add b", "Adds b, made by a machine.\n");
    refused(
        &h.check(&seal, &head, &[]),
        "the title and body has blocking names (ai_phrase)",
    );
}

#[test]
fn a_head_that_conflicts_with_the_base_refuses() {
    let f = Fixture::new("conflict");
    let head = f.commit("a.txt", "topic\n", &format!("Change a\n\n{SIGNOFF}"));
    let seal = f.seal("Change a", "Changes a.\n");
    let work = f.work();
    git(&work, &["checkout", "-q", "main"]);
    fs::write(work.join("a.txt"), "main moved\n").unwrap();
    git(
        &work,
        &["commit", "-q", "-am", &format!("Move main\n\n{SIGNOFF}")],
    );
    let store = f.root.join("store.git");
    git(
        &store,
        &[
            "fetch",
            "-q",
            work.to_str().unwrap(),
            "+main:refs/heads/main",
        ],
    );
    refused(&f.check(&seal, &head, &[]), "does not merge cleanly");
}

#[test]
fn the_approval_record_binds_the_exact_commit_patch_title_and_body() {
    let f = Fixture::new("approval");
    let head = f.commit("b.txt", "two\n", &format!("Add b\n\n{SIGNOFF}"));
    let seal = f.seal("Add b", "Adds b.\n");
    let work = f.work();
    let raw = Command::new("git")
        .args(["cat-file", "commit", &head])
        .current_dir(&work)
        .output()
        .unwrap()
        .stdout;
    let patch = Command::new("git")
        .args(["diff", "--binary", "--full-index", "main", &head])
        .current_dir(&work)
        .output()
        .unwrap()
        .stdout;
    let record = |body: &str| {
        serde_json::json!({
            "publicationAuthorized": true,
            "repo": "owner/demo",
            "head": head,
            "tree": git(&work, &["rev-parse", &format!("{head}^{{tree}}")]),
            "rawCommitSha256": sha256_hex(&raw),
            "base": git(&work, &["rev-parse", "main"]),
            "patchSha256": sha256_hex(&patch),
            "titleSha256": sha256_hex(b"Add b"),
            "bodySha256": sha256_hex(body.as_bytes()),
            "reviews": ["source GO 0000aaaa"],
        })
    };
    let path = f.root.join("approval.json");
    fs::write(&path, record("Adds b.\n").to_string()).unwrap();
    let out = f.check(&seal, &head, &["--approval", path.to_str().unwrap()]);
    assert_eq!(out.status.code(), Some(0), "{}", stderr(&out));

    fs::write(&path, record("Adds b, as reviewed earlier.\n").to_string()).unwrap();
    refused(
        &f.check(&seal, &head, &["--approval", path.to_str().unwrap()]),
        "not the approved body",
    );

    let mut unauthorized = record("Adds b.\n");
    unauthorized["publicationAuthorized"] = serde_json::Value::Bool(false);
    fs::write(&path, unauthorized.to_string()).unwrap();
    refused(
        &f.check(&seal, &head, &["--approval", path.to_str().unwrap()]),
        "does not authorize",
    );

    // The same change re-committed later is a different object: the approval does not carry over.
    let mut stale = record("Adds b.\n");
    stale["rawCommitSha256"] = serde_json::Value::String(sha256_hex(b"another commit"));
    fs::write(&path, stale.to_string()).unwrap();
    refused(
        &f.check(&seal, &head, &["--approval", path.to_str().unwrap()]),
        "not the approved one",
    );
}

/// Moves `main` with a change to `file` and merges it into `topic`, resolving any conflict in
/// `file` with `resolution`; returns the merge commit.
fn merge_main(f: &Fixture, file: &str, main_content: &str, resolution: &str) -> String {
    let work = f.work();
    git(&work, &["checkout", "-q", "main"]);
    fs::write(work.join(file), main_content).unwrap();
    git(&work, &["add", file]);
    git(
        &work,
        &["commit", "-q", "-m", &format!("Move main\n\n{SIGNOFF}")],
    );
    git(
        &f.root.join("store.git"),
        &[
            "fetch",
            "-q",
            work.to_str().unwrap(),
            "+main:refs/heads/main",
        ],
    );
    git(&work, &["checkout", "-q", "topic"]);
    let _ = Command::new("git")
        .args([
            "-c",
            "user.name=x",
            "-c",
            "user.email=x@example.invalid",
            "merge",
            "-q",
            "--no-commit",
            "main",
        ])
        .current_dir(&work)
        .output();
    fs::write(work.join(file), resolution).unwrap();
    git(&work, &["add", file]);
    git(
        &work,
        &["commit", "-q", "-m", &format!("Merge main\n\n{SIGNOFF}")],
    );
    git(&work, &["rev-parse", "HEAD"])
}

#[test]
fn a_merge_main_is_judged_by_what_the_merge_itself_adds() {
    let f = Fixture::new("merge-clean");
    f.commit("b.txt", "two\n", &format!("Add b\n\n{SIGNOFF}"));
    let head = merge_main(&f, "c.txt", "three\n", "three\n");
    let seal = f.seal("Add b", "Adds b.\n");
    let out = f.check(&seal, &head, &[]);
    assert_eq!(out.status.code(), Some(0), "{}", stderr(&out));
    let summary: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(summary["merges"], 1);

    let g = Fixture::new("merge-resolution");
    g.commit("a.txt", "topic\n", &format!("Change a\n\n{SIGNOFF}"));
    let head = merge_main(&g, "a.txt", "main\n", "settled by zorblat\n");
    let seal = g.seal("Change a", "Changes a.\n");
    refused(
        &g.check(&seal, &head, &[]),
        "added lines has blocking names (team)",
    );
}
