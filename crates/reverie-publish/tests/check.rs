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
        self.check_env(seal, head, extra, &[])
    }

    fn check_env(&self, seal: &str, head: &str, extra: &[&str], envs: &[(&str, &str)]) -> Output {
        self.command(seal, head, extra)
            .envs(envs.iter().copied())
            .output()
            .unwrap()
    }

    /// The check command against this fixture's packet, store and lists.
    fn command(&self, seal: &str, head: &str, extra: &[&str]) -> Command {
        let (packet, store) = (self.root.join("packet"), self.root.join("store.git"));
        let mut command = self.command_at(seal, head, &packet, &store);
        command.args(extra);
        command
    }

    fn command_at(&self, seal: &str, head: &str, packet: &Path, store: &Path) -> Command {
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
    fn copies(&self) -> Vec<String> {
        fs::read_dir(self.root.join("store.git"))
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .filter(|n| n.starts_with("publish-packet-"))
            .collect()
    }

    /// An approval record for `head` against `base`, covering `title` and `body`.
    fn approval(&self, head: &str, base: &str, title: &str, body: &str) -> serde_json::Value {
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

    fn with_approval(&self, approval: &serde_json::Value) -> String {
        let path = self.root.join("approval.json");
        fs::write(&path, approval.to_string()).unwrap();
        path.to_string_lossy().into_owned()
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

/// An executable helper written at test time that leaves `marker` behind whenever git runs it.
fn helper(f: &Fixture, name: &str, rest: &str) -> (PathBuf, PathBuf) {
    let marker = f.root.join(format!("{name}-ran"));
    let script = f.root.join(format!("{name}.sh"));
    fs::write(
        &script,
        format!("#!/bin/sh\ntouch \"{}\"\n{rest}\n", marker.display()),
    )
    .unwrap();
    fs::set_permissions(&script, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    (script, marker)
}

#[test]
fn a_store_url_rewrite_cannot_replace_the_sealed_bundle() {
    let f = Fixture::new("store-rewrite");
    let head = f.commit("b.txt", "two\n", &format!("Add b\n\n{SIGNOFF}"));
    let seal = f.seal("Add b", "Adds b.\n");
    // A clean, signed-off commit that was never put in the sealed bundle.
    let work = f.work();
    git(&work, &["checkout", "-q", "-b", "foreign", "main"]);
    fs::write(work.join("c.txt"), "foreign\n").unwrap();
    git(&work, &["add", "c.txt"]);
    git(
        &work,
        &["commit", "-q", "-m", &format!("Add c\n\n{SIGNOFF}")],
    );
    let foreign = git(&work, &["rev-parse", "HEAD"]);
    // The store's own config sends the bundle fetch to a helper serving that other repository.
    let (transport, ran) = helper(
        &f,
        "transport",
        &format!("exec git-upload-pack \"{}\"", work.display()),
    );
    let store = f.root.join("store.git");
    git(&store, &["config", "protocol.ext.allow", "always"]);
    git(
        &store,
        &[
            "config",
            &format!("url.ext::{} .insteadOf", transport.display()),
            "./",
        ],
    );
    // Only the sealed bundle is fetched, so the foreign commit is not even present to resolve.
    refused(&f.check(&seal, &foreign, &[]), "");
    assert!(!ran.exists(), "the store's transport rewrite ran");
    // The sealed head still passes with that config in place.
    let out = f.check(&seal, &head, &[]);
    assert_eq!(out.status.code(), Some(0), "{}", stderr(&out));
    assert!(!ran.exists(), "the store's transport rewrite ran");
}

#[test]
fn a_store_merge_driver_cannot_hide_a_conflict() {
    let f = Fixture::new("store-driver");
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
    // The store's own config names a merge driver that declares every conflict resolved.
    let (driver, ran) = helper(&f, "driver", "exit 0");
    let attributes = f.root.join("attributes");
    fs::write(&attributes, "a.txt merge=owned\n").unwrap();
    git(
        &store,
        &[
            "config",
            "core.attributesFile",
            attributes.to_str().unwrap(),
        ],
    );
    git(
        &store,
        &[
            "config",
            "merge.owned.driver",
            &format!("{} %O %A %B", driver.display()),
        ],
    );
    refused(&f.check(&seal, &head, &[]), "does not merge cleanly");
    assert!(!ran.exists(), "the store's merge driver ran");
}

#[test]
fn ambient_user_attributes_cannot_hide_a_conflict() {
    let f = Fixture::new("ambient-attributes");
    let head = f.commit("a.txt", "topic\n", &format!("Change a\n\n{SIGNOFF}"));
    let seal = f.seal("Change a", "Changes a.\n");
    let work = f.work();
    git(&work, &["checkout", "-q", "main"]);
    fs::write(work.join("a.txt"), "main moved\n").unwrap();
    git(
        &work,
        &["commit", "-q", "-am", &format!("Move main\n\n{SIGNOFF}")],
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
    refused(&f.check(&seal, &head, &[]), "does not merge cleanly");
    // The same conflict with a union merge named in the user's attributes, by XDG and by HOME.
    let xdg = f.root.join("xdg");
    fs::create_dir_all(xdg.join("git")).unwrap();
    fs::write(xdg.join("git/attributes"), "a.txt merge=union\n").unwrap();
    let home = f.root.join("home");
    fs::create_dir_all(home.join(".config/git")).unwrap();
    fs::write(home.join(".config/git/attributes"), "a.txt merge=union\n").unwrap();
    for envs in [
        vec![("XDG_CONFIG_HOME", xdg.to_str().unwrap())],
        vec![("HOME", home.to_str().unwrap())],
    ] {
        let out = f.check_env(&seal, &head, &[], &envs);
        refused(&out, "does not merge cleanly");
    }
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

#[test]
fn an_approval_for_another_head_or_base_does_not_cover_the_checked_one() {
    let f = Fixture::new("approval-other");
    let first = f.commit("b.txt", "two\n", &format!("Add b\n\n{SIGNOFF}"));
    let approved = f.approval(&first, "main", "Add b", "Adds b.\n");
    // An unreviewed second revision on top, with the same title and body.
    let second = f.commit(
        "b.txt",
        "two, changed after review\n",
        &format!("Change b\n\n{SIGNOFF}"),
    );
    let seal = f.seal("Add b", "Adds b.\n");
    let path = f.with_approval(&approved);
    refused(
        &f.check(&seal, &second, &["--approval", &path]),
        "the approval is for another head",
    );

    // A record consistent for `second` against `first` does not cover a check against main.
    let other_base = f.approval(&second, &first, "Add b", "Adds b.\n");
    let path = f.with_approval(&other_base);
    refused(
        &f.check(&seal, &second, &["--approval", &path]),
        "the approval is for another base",
    );
}

#[test]
fn an_added_line_that_starts_with_plus_plus_is_still_scanned() {
    let f = Fixture::new("plusplus");
    let head = f.commit("b.txt", "++zorblat\n", &format!("Add b\n\n{SIGNOFF}"));
    let seal = f.seal("Add b", "Adds b.\n");
    refused(
        &f.check(&seal, &head, &[]),
        "added lines has blocking names (team)",
    );
}

#[test]
fn a_symlink_anywhere_in_the_packet_refuses() {
    use std::os::unix::fs::symlink;
    let f = Fixture::new("symlink-body");
    let head = f.commit("b.txt", "two\n", &format!("Add b\n\n{SIGNOFF}"));
    f.seal("Add b", "Adds b.\n");
    let packet = f.root.join("packet");
    fs::write(f.root.join("outside.md"), "Adds b.\n").unwrap();
    fs::remove_file(packet.join("BODY.md")).unwrap();
    symlink(f.root.join("outside.md"), packet.join("BODY.md")).unwrap();
    let seal = f.reseal();
    refused(
        &f.check(&seal, &head, &[]),
        "BODY.md: a symlink in the packet is refused",
    );

    let g = Fixture::new("symlink-sums");
    let head = g.commit("b.txt", "two\n", &format!("Add b\n\n{SIGNOFF}"));
    let seal = g.seal("Add b", "Adds b.\n");
    let packet = g.root.join("packet");
    fs::rename(packet.join("SHA256SUMS"), g.root.join("SUMS-outside")).unwrap();
    symlink(g.root.join("SUMS-outside"), packet.join("SHA256SUMS")).unwrap();
    refused(
        &g.check(&seal, &head, &[]),
        "SHA256SUMS: a symlink in the packet is refused",
    );

    let h = Fixture::new("symlink-dir");
    let head = h.commit("b.txt", "two\n", &format!("Add b\n\n{SIGNOFF}"));
    h.seal("Add b", "Adds b.\n");
    let outside = h.root.join("outside-dir");
    fs::create_dir_all(&outside).unwrap();
    fs::write(outside.join("notes.txt"), "kept outside\n").unwrap();
    symlink(&outside, h.root.join("packet/sub")).unwrap();
    let packet = h.root.join("packet");
    let mut sums = fs::read_to_string(packet.join("SHA256SUMS")).unwrap();
    sums.push_str(&format!(
        "{}  sub/notes.txt\n",
        sha256_hex(b"kept outside\n")
    ));
    fs::write(packet.join("SHA256SUMS"), &sums).unwrap();
    let seal = sha256_hex(sums.as_bytes())[..8].to_owned();
    refused(
        &h.check(&seal, &head, &[]),
        "a symlink in the packet is refused",
    );
}

#[test]
fn git_configuration_from_the_environment_cannot_run_a_hook() {
    use std::os::unix::fs::symlink;
    let f = Fixture::new("env-hook");
    let head = f.commit("b.txt", "two\n", &format!("Add b\n\n{SIGNOFF}"));
    let seal = f.seal("Add b", "Adds b.\n");
    // A hook that leaves a mark: git runs it with "prepared"/"committed" in the object store.
    let hooks = f.root.join("hooks");
    fs::create_dir_all(&hooks).unwrap();
    let touch = std::env::var_os("PATH")
        .and_then(|paths| {
            std::env::split_paths(&paths)
                .map(|p| p.join("touch"))
                .find(|p| p.is_file())
        })
        .expect("touch on PATH");
    symlink(touch, hooks.join("reference-transaction")).unwrap();
    let hooks = hooks.to_string_lossy().into_owned();
    let envs = [
        ("GIT_CONFIG_COUNT", "1"),
        ("GIT_CONFIG_KEY_0", "core.hooksPath"),
        ("GIT_CONFIG_VALUE_0", hooks.as_str()),
    ];
    let out = f.check_env(&seal, &head, &[], &envs);
    assert_eq!(out.status.code(), Some(0), "{}", stderr(&out));
    for mark in ["prepared", "committed"] {
        assert!(
            !f.root.join("store.git").join(mark).exists(),
            "the injected hook ran ({mark})"
        );
    }
}

#[test]
fn objects_from_outside_the_sealed_bundle_are_not_visible() {
    let f = Fixture::new("alternates");
    f.commit("b.txt", "two\n", &format!("Add b\n\n{SIGNOFF}"));
    let seal = f.seal("Add b", "Adds b.\n");
    // A commit that exists only in the work repository, never in the bundle.
    let work = f.work();
    git(&work, &["checkout", "-q", "-b", "elsewhere", "main"]);
    fs::write(work.join("c.txt"), "three\n").unwrap();
    git(&work, &["add", "c.txt"]);
    git(
        &work,
        &["commit", "-q", "-m", &format!("Add c\n\n{SIGNOFF}")],
    );
    let outside = git(&work, &["rev-parse", "HEAD"]);
    let objects = work.join(".git/objects").to_string_lossy().into_owned();
    let out = f.check_env(
        &seal,
        &outside,
        &[],
        &[("GIT_ALTERNATE_OBJECT_DIRECTORIES", objects.as_str())],
    );
    assert_eq!(
        out.status.code(),
        Some(1),
        "a commit outside the bundle was accepted: {}",
        stderr(&out)
    );
}

#[test]
fn a_hook_inside_the_object_store_does_not_run() {
    use std::os::unix::fs::symlink;
    let f = Fixture::new("store-hook");
    let head = f.commit("b.txt", "two\n", &format!("Add b\n\n{SIGNOFF}"));
    let seal = f.seal("Add b", "Adds b.\n");
    let touch = std::env::var_os("PATH")
        .and_then(|paths| {
            std::env::split_paths(&paths)
                .map(|p| p.join("touch"))
                .find(|p| p.is_file())
        })
        .expect("touch on PATH");
    let hooks = f.root.join("store.git/hooks");
    fs::create_dir_all(&hooks).unwrap();
    symlink(touch, hooks.join("reference-transaction")).unwrap();
    let out = f.check(&seal, &head, &[]);
    assert_eq!(out.status.code(), Some(0), "{}", stderr(&out));
    for mark in ["prepared", "committed"] {
        assert!(
            !f.root.join("store.git").join(mark).exists(),
            "the store's hook ran ({mark})"
        );
    }
}

#[test]
fn a_packet_or_store_reached_through_a_symlink_refuses() {
    use std::os::unix::fs::symlink;
    let f = Fixture::new("root-alias");
    let head = f.commit("b.txt", "two\n", &format!("Add b\n\n{SIGNOFF}"));
    let seal = f.seal("Add b", "Adds b.\n");
    symlink(f.root.join("packet"), f.root.join("packet-alias")).unwrap();
    symlink(&f.root, f.root.join("up")).unwrap();
    symlink(f.root.join("store.git"), f.root.join("store-alias")).unwrap();
    let (packet, store) = (f.root.join("packet"), f.root.join("store.git"));
    for (packet, store) in [
        (f.root.join("packet-alias"), store.clone()),
        (f.root.join("up/packet"), store.clone()),
        (packet.clone(), f.root.join("store-alias")),
        (packet.clone(), f.root.join("up/store.git")),
    ] {
        let out = f
            .command_at(&seal, &head, &packet, &store)
            .output()
            .unwrap();
        refused(&out, "is a symlink; the path must not pass through one");
    }
    let out = f.check(&seal, &head, &[]);
    assert_eq!(out.status.code(), Some(0), "{}", stderr(&out));
}

#[test]
fn an_existing_entry_in_the_store_is_never_written_through() {
    use std::os::unix::fs::symlink;
    let f = Fixture::new("copy-escape");
    let head = f.commit("b.txt", "two\n", &format!("Add b\n\n{SIGNOFF}"));
    let seal = f.seal("Add b", "Adds b.\n");
    let store = f.root.join("store.git");
    fs::write(f.root.join("outside-canary"), "outside\n").unwrap();
    symlink(
        f.root.join("outside-canary"),
        store.join("publish-packet.bundle"),
    )
    .unwrap();
    fs::write(store.join("publish-packet-kept.bundle"), "kept\n").unwrap();
    let out = f.check(&seal, &head, &[]);
    assert_eq!(out.status.code(), Some(0), "{}", stderr(&out));
    assert_eq!(
        fs::read(f.root.join("outside-canary")).unwrap(),
        b"outside\n"
    );
    assert_eq!(
        fs::read(store.join("publish-packet-kept.bundle")).unwrap(),
        b"kept\n"
    );
    assert_eq!(f.copies(), ["publish-packet-kept.bundle"]);
}

#[test]
fn concurrent_checks_on_one_store_share_no_copy_and_leave_none() {
    let f = Fixture::new("concurrent");
    let head = f.commit("b.txt", "two\n", &format!("Add b\n\n{SIGNOFF}"));
    let seal = f.seal("Add b", "Adds b.\n");
    let children: Vec<_> = (0..2)
        .map(|_| {
            f.command(&seal, &head, &[])
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .spawn()
                .unwrap()
        })
        .collect();
    for child in children {
        let out = child.wait_with_output().unwrap();
        assert_eq!(out.status.code(), Some(0), "{}", stderr(&out));
    }
    assert!(f.copies().is_empty(), "{:?}", f.copies());
    // Each run's import refs live in its own private git directory, never in the shared store.
    let refs = git(
        &f.root.join("store.git"),
        &["for-each-ref", "--format=%(refname)", "refs/publish/"],
    );
    assert_eq!(refs, "");
}

#[test]
fn a_commit_already_in_the_store_but_not_in_the_bundle_refuses() {
    let f = Fixture::new("preloaded");
    f.commit("b.txt", "two\n", &format!("Add b\n\n{SIGNOFF}"));
    let seal = f.seal("Add b", "Adds b.\n");
    // A clean, signed-off commit put straight into the store, never into the bundle.
    let work = f.work();
    git(&work, &["checkout", "-q", "-b", "elsewhere", "main"]);
    fs::write(work.join("c.txt"), "three\n").unwrap();
    git(&work, &["add", "c.txt"]);
    git(
        &work,
        &["commit", "-q", "-m", &format!("Add c\n\n{SIGNOFF}")],
    );
    let preloaded = git(&work, &["rev-parse", "HEAD"]);
    git(
        &f.root.join("store.git"),
        &[
            "fetch",
            "-q",
            work.to_str().unwrap(),
            "elsewhere:refs/heads/elsewhere",
        ],
    );
    refused(
        &f.check(&seal, &preloaded, &[]),
        "--head must be the tip of a ref in the sealed bundle",
    );
}
