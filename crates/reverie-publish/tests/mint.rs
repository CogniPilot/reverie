//! The real `reverie-publish mint-merge-main` against throwaway repositories: a PR branch, a main
//! that moved on, and a bare object store holding both.
use reverie_publish::sha256_hex;
use serde_json::Value;
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Output},
};

const SIGNOFF: &str = "Signed-off-by: James Goppert <jgoppert@users.noreply.github.com>";
/// Invented entries only: the gate must block them without any real name in the repository.
const LISTS: &str = r#"{"schema":1,"home_repo":"demo","team":["zorblat"],"internal":["quuxhost"],"ai_words":["robotronix"],"ai_phrases":["made by a machine"],"path_markers":["/opt/hidden-zone/"],"allow":["harmless"]}"#;

struct Repo {
    root: PathBuf,
}

impl Drop for Repo {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn git(dir: &Path, args: &[&str]) -> String {
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
        .env("GIT_AUTHOR_NAME", "James Goppert")
        .env("GIT_AUTHOR_EMAIL", "jgoppert@users.noreply.github.com")
        .env("GIT_COMMITTER_NAME", "James Goppert")
        .env("GIT_COMMITTER_EMAIL", "jgoppert@users.noreply.github.com")
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_owned()
}

impl Repo {
    /// main with `a.txt` (five lines), and a branch `topic` from it.
    fn new(name: &str) -> Self {
        let root = std::env::temp_dir().join(format!("publish-mint-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("work")).unwrap();
        let repo = Self { root };
        let work = repo.work();
        git(&work, &["init", "-q"]);
        fs::write(work.join("a.txt"), "1\n2\n3\n4\n5\n").unwrap();
        repo.commit("main", "a.txt", None, "Base");
        git(&work, &["branch", "topic"]);
        git(&repo.root, &["init", "-q", "--bare", "store.git"]);
        fs::write(repo.root.join("lists.json"), LISTS).unwrap();
        repo
    }

    fn work(&self) -> PathBuf {
        self.root.join("work")
    }

    /// Writes `content` (if any) to `file` on `branch`, commits with `subject` and returns it.
    fn commit(&self, branch: &str, file: &str, content: Option<&str>, subject: &str) -> String {
        let work = self.work();
        let _ = Command::new("git")
            .args(["checkout", "-q", branch])
            .current_dir(&work)
            .output();
        if let Some(content) = content {
            fs::write(work.join(file), content).unwrap();
        }
        git(&work, &["add", file]);
        git(
            &work,
            &["commit", "-q", "-m", &format!("{subject}\n\n{SIGNOFF}")],
        );
        git(&work, &["rev-parse", "HEAD"])
    }

    fn store(&self) -> PathBuf {
        self.root.join("store.git")
    }

    /// Copies `main` and `topic` into the store and returns their ids.
    fn load(&self) -> (String, String) {
        let work = self.work();
        git(
            &self.store(),
            &[
                "fetch",
                "-q",
                work.to_str().unwrap(),
                "main:refs/heads/main",
                "topic:refs/heads/topic",
            ],
        );
        (
            git(&work, &["rev-parse", "topic"]),
            git(&work, &["rev-parse", "main"]),
        )
    }

    fn mint(&self, head: &str, main: &str, branch: &str, out: &Path) -> Output {
        self.mint_env(head, main, branch, out, &[])
    }

    fn mint_env(
        &self,
        head: &str,
        main: &str,
        branch: &str,
        out: &Path,
        envs: &[(&str, &std::ffi::OsStr)],
    ) -> Output {
        Command::new(env!("CARGO_BIN_EXE_reverie-publish"))
            .envs(envs.iter().copied())
            .args([
                "mint-merge-main",
                "--repo",
                "owner/demo",
                "--head",
                head,
                "--main",
                main,
            ])
            .args([
                "--branch",
                branch,
                "--lists-sha256",
                &sha256_hex(LISTS.as_bytes()),
            ])
            .arg("--git-dir")
            .arg(self.store())
            .arg("--lists")
            .arg(self.root.join("lists.json"))
            .arg("--out")
            .arg(out)
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

/// main edits line 5 and adds `c.txt`; topic edits line 1 and adds `b.txt`.
fn diverged(name: &str) -> Repo {
    let repo = Repo::new(name);
    repo.commit(
        "topic",
        "a.txt",
        Some("one\n2\n3\n4\n5\n"),
        "Topic edits line one",
    );
    repo.commit("topic", "b.txt", Some("b\n"), "Topic adds b");
    repo.commit(
        "main",
        "a.txt",
        Some("1\n2\n3\n4\nfive\n"),
        "Main edits line five",
    );
    repo.commit("main", "c.txt", Some("c\n"), "Main adds c");
    repo
}

#[test]
fn a_clean_merge_main_is_minted_checked_and_sealed() {
    let repo = diverged("clean");
    let (head, main) = repo.load();
    let out = repo.root.join("packet");
    let result = repo.mint(&head, &main, "topic", &out);
    assert_eq!(result.status.code(), Some(0), "{}", stderr(&result));
    let summary: Value = serde_json::from_slice(&result.stdout).unwrap();
    let commit = summary["commit"].as_str().unwrap().to_owned();
    assert_eq!(summary["parents"], serde_json::json!([head, main]));
    let store = repo.store();
    let parents = git(&store, &["rev-list", "--parents", "-n", "1", &commit]);
    assert_eq!(parents, format!("{commit} {head} {main}"));
    assert_eq!(
        git(&store, &["rev-parse", &format!("{commit}^{{tree}}")]),
        git(&store, &["merge-tree", "--write-tree", &head, &main])
    );
    let raw = git(&store, &["cat-file", "commit", &commit]);
    assert!(raw.contains("\nauthor James Goppert <jgoppert@users.noreply.github.com> "));
    assert!(raw.contains("\ncommitter James Goppert <jgoppert@users.noreply.github.com> "));
    assert!(
        raw.ends_with(&format!("Merge main into topic\n\n{SIGNOFF}")),
        "{raw}"
    );
    // The packet: every file listed and sealed, and the bundle carries the merge and the PR.
    let sums = fs::read_to_string(out.join("SHA256SUMS")).unwrap();
    assert_eq!(summary["seal"], sha256_hex(sums.as_bytes())[..8]);
    for line in sums.lines() {
        let (hash, file) = line.split_once("  ").unwrap();
        assert_eq!(
            sha256_hex(&fs::read(out.join(file)).unwrap()),
            hash,
            "{file}"
        );
    }
    assert_eq!(sums.lines().count(), 6);
    let check = repo.root.join("check.git");
    git(&repo.root, &["init", "-q", "--bare", "check.git"]);
    git(
        &check,
        &[
            "fetch",
            "-q",
            repo.work().to_str().unwrap(),
            "main:refs/heads/main",
        ],
    );
    git(
        &check,
        &[
            "fetch",
            "-q",
            out.join("source.bundle").to_str().unwrap(),
            "+refs/*:refs/b/*",
        ],
    );
    assert_eq!(
        git(&check, &["rev-parse", &format!("{commit}^{{commit}}")]),
        commit
    );
    // A second mint into the same packet refuses: a sealed packet is never rewritten.
    refused(
        &repo.mint(&head, &main, "topic", &out),
        "is never rewritten",
    );
}

#[test]
fn a_conflict_refuses_and_writes_no_packet() {
    let repo = Repo::new("conflict");
    let head = repo.commit(
        "topic",
        "a.txt",
        Some("1\n2\nthree\n4\n5\n"),
        "Topic edits three",
    );
    let main = repo.commit(
        "main",
        "a.txt",
        Some("1\n2\nTHREE\n4\n5\n"),
        "Main edits three",
    );
    repo.load();
    let out = repo.root.join("packet");
    refused(
        &repo.mint(&head, &main, "topic", &out),
        "does not merge cleanly",
    );
    assert!(!out.exists());
}

#[test]
fn a_merge_that_adds_anything_but_mains_change_refuses() {
    // Both sides make the same edit: the merge adds nothing for it, so its delta is not main's.
    let repo = Repo::new("same-edit");
    repo.commit(
        "topic",
        "a.txt",
        Some("1\n2\n3\n4\nfive\n"),
        "Topic edits five",
    );
    repo.commit("topic", "b.txt", Some("b\n"), "Topic adds b");
    repo.commit(
        "main",
        "a.txt",
        Some("1\n2\n3\n4\nfive\n"),
        "Main edits five",
    );
    repo.commit("main", "c.txt", Some("c\n"), "Main adds c");
    let (head, main) = repo.load();
    let out = repo.root.join("packet");
    refused(
        &repo.mint(&head, &main, "topic", &out),
        "is not main's own change",
    );
    assert!(!out.exists());
}

#[test]
fn bad_inputs_refuse_before_anything_is_minted() {
    let repo = diverged("inputs");
    let (head, main) = repo.load();
    let out = repo.root.join("packet");
    refused(
        &repo.mint(&head[..12], &main, "topic", &out),
        "--head must be the full id",
    );
    refused(
        &repo.mint(&head, &head, "topic", &out),
        "already contains main",
    );
    refused(&repo.mint(&head, &main, "zorblat-fix", &out), "message");
    std::os::unix::fs::symlink(&repo.root, repo.root.join("alias")).unwrap();
    refused(
        &repo.mint(&head, &main, "topic", &repo.root.join("alias/packet")),
        "is a symlink",
    );
    assert!(!out.exists());
    assert!(!repo.root.join("packet").exists());
    let minted = git(&repo.store(), &["for-each-ref", "refs/publish/mint/"]);
    assert!(
        minted.is_empty(),
        "nothing is minted for a refused input: {minted}"
    );
}

/// The first `name` on PATH.
fn on_path(name: &str) -> PathBuf {
    std::env::var_os("PATH")
        .and_then(|paths| {
            std::env::split_paths(&paths)
                .map(|p| p.join(name))
                .find(|p| p.is_file())
        })
        .unwrap_or_else(|| panic!("{name} on PATH"))
}

/// Mints with a `git` first on PATH that runs the real one, but just before the first git call
/// naming `at` renames `swap` to `<swap>.held` and puts a symlink to `to` in its place. That `git`
/// is tests/support/git_swap.rs, built here with rustc.
fn mint_swapping(repo: &Repo, out: &Path, at: &str, swap: &Path, to: &Path) -> Output {
    let (head, main) = repo.load();
    let shims = repo.root.join("shims");
    fs::create_dir_all(&shims).unwrap();
    let source = repo.root.join("git_swap.rs");
    fs::write(&source, include_str!("support/git_swap.rs")).unwrap();
    let built = Command::new("rustc")
        .args(["--edition=2024", "-o"])
        .arg(shims.join("git"))
        .arg(&source)
        .status()
        .unwrap();
    assert!(built.success(), "the git shim builds");
    let path = std::env::join_paths(
        std::iter::once(shims).chain(std::env::split_paths(&std::env::var_os("PATH").unwrap())),
    )
    .unwrap();
    let real = on_path("git");
    repo.mint_env(
        &head,
        &main,
        "topic",
        out,
        &[
            ("PATH", path.as_os_str()),
            ("REAL_GIT", real.as_os_str()),
            ("SWAP_AT", at.as_ref()),
            ("SWAP_PATH", swap.as_os_str()),
            ("SWAP_TO", to.as_os_str()),
        ],
    )
}

fn entries(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

#[test]
fn a_parent_swapped_while_minting_refuses_and_nothing_is_made_anywhere() {
    let repo = diverged("swap-parent");
    let parent = repo.root.join("drop");
    let outside = repo.root.join("outside");
    fs::create_dir(&parent).unwrap();
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("kept.txt"), "outside\n").unwrap();
    let out = parent.join("packet");
    // At commit-tree the checked parent is moved away and its name becomes a symlink outside.
    refused(
        &mint_swapping(&repo, &out, "commit-tree", &parent, &outside),
        "no longer names the directory held for --out",
    );
    assert!(
        parent.symlink_metadata().unwrap().file_type().is_symlink(),
        "the swap ran"
    );
    assert!(entries(&repo.root.join("drop.held")).is_empty());
    assert_eq!(entries(&outside), ["kept.txt"]);
    assert_eq!(fs::read(outside.join("kept.txt")).unwrap(), b"outside\n");
}

#[test]
fn a_packet_swapped_after_it_is_made_is_written_only_where_it_is_held() {
    let repo = diverged("swap-packet");
    let outside = repo.root.join("outside");
    fs::create_dir(&outside).unwrap();
    let out = repo.root.join("packet");
    // At bundle, after the packet directory is made, it is moved away and its name becomes a
    // symlink outside: the files go into the held directory, the outside stays empty, and the
    // run refuses because --out no longer names what was written.
    refused(
        &mint_swapping(&repo, &out, "bundle", &out, &outside),
        "no longer names the packet just written",
    );
    assert!(entries(&outside).is_empty());
    let held = repo.root.join("packet.held");
    assert_eq!(
        entries(&held),
        [
            "DELTA-U0.diff",
            "MAIN-DELTA-U0.diff",
            "MERGE-COMMIT.txt",
            "REMERGE.diff",
            "SHA256SUMS",
            "SUMMARY.json",
            "source.bundle"
        ]
    );
}
