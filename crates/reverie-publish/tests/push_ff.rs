//! The real `reverie-publish push-ff` against a local bare remote holding a PR branch, and a
//! loopback server standing in for GitHub's API.
mod common;

use common::*;
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Output},
    sync::{Arc, Mutex},
};

const TITLE: &str = "Add b and c";
const BODY: &str = "Adds b, then c.\n";

/// A PR (number 7) whose branch `topic` on `remote.git` is at `old`, and a sealed packet whose
/// reviewed head `head` fast-forwards it.
struct Pr {
    fixture: Fixture,
    old: String,
    head: String,
    seal: String,
}

fn rev(git_dir: &Path, reference: &str) -> String {
    let out = Command::new("git")
        .arg("--git-dir")
        .arg(git_dir)
        .args(["rev-parse", "--verify", reference])
        .output()
        .unwrap();
    String::from_utf8_lossy(&out.stdout).trim().to_owned()
}

fn prepared(name: &str) -> Pr {
    let fixture = Fixture::new(name);
    let old = fixture.commit("b.txt", "two\n", &format!("Add b\n\n{SIGNOFF}"));
    git(&fixture.root, &["init", "-q", "--bare", "remote.git"]);
    let work = fixture.work();
    git(
        &fixture.root.join("remote.git"),
        &[
            "fetch",
            "-q",
            work.to_str().unwrap(),
            "main:refs/heads/main",
            "topic:refs/heads/topic",
        ],
    );
    let head = fixture.commit("c.txt", "three\n", &format!("Add c\n\n{SIGNOFF}"));
    let seal = fixture.seal(TITLE, BODY);
    let approval = fixture.approval(&head, "main", TITLE, BODY);
    fs::write(fixture.root.join("approval.json"), approval.to_string()).unwrap();
    fs::write(fixture.root.join("token"), "testtoken\n").unwrap();
    Pr {
        fixture,
        old,
        head,
        seal,
    }
}

/// How the fake API describes the PR.
#[derive(Clone)]
struct Api {
    head_repo: &'static str,
    can_modify: bool,
    /// The head the API reports; by default whatever `remote.git` has on `topic`.
    head: Option<String>,
    /// Whether a PATCH changes the title and body.
    accepts_text: bool,
}

const SAME_REPO: Api = Api {
    head_repo: "owner/demo",
    can_modify: false,
    head: None,
    accepts_text: true,
};

impl Pr {
    fn remote(&self) -> PathBuf {
        self.fixture.root.join("remote.git")
    }

    fn records(&self) -> PathBuf {
        self.fixture.root.join("records")
    }

    fn branch(&self) -> String {
        rev(&self.remote(), "refs/heads/topic")
    }

    /// Serves GET and PATCH on the PR and the runs list, keeping the PR's text between calls.
    fn api(&self, api: Api) -> (String, Arc<Mutex<Vec<Seen>>>) {
        let remote = self.remote();
        let text = Mutex::new(("Old title".to_owned(), "Old body\n".to_owned()));
        fake_api(move |seen| {
            if seen.path.starts_with("/repos/owner/demo/actions/runs") {
                return json!({ "total_count": 1, "workflow_runs": [] });
            }
            let mut text = text.lock().unwrap();
            if seen.method == "PATCH" && api.accepts_text {
                text.0 = seen.body["title"].as_str().unwrap_or_default().to_owned();
                text.1 = seen.body["body"].as_str().unwrap_or_default().to_owned();
            }
            let head = api
                .head
                .clone()
                .unwrap_or_else(|| rev(&remote, "refs/heads/topic"));
            json!({
                "number": 7,
                "state": "open",
                "html_url": "https://example.invalid/pull/7",
                "maintainer_can_modify": api.can_modify,
                "head": { "sha": head, "ref": "topic", "repo": { "full_name": api.head_repo } },
                "base": { "ref": "main", "repo": { "full_name": "owner/demo" } },
                "title": text.0,
                "body": text.1,
            })
        })
    }

    fn run(&self, api: &str, old: &str, extra: &[&str]) -> Output {
        self.command(api, old, extra).output().unwrap()
    }

    fn command(&self, api: &str, old: &str, extra: &[&str]) -> Command {
        let root = &self.fixture.root;
        let tree = git(
            &self.fixture.work(),
            &["rev-parse", &format!("{}^{{tree}}", self.head)],
        );
        let mut command = Command::new(env!("CARGO_BIN_EXE_reverie-publish"));
        command
            .args(["push-ff", "--repo", "owner/demo", "--pr", "7", "--old", old])
            .args(["--head", &self.head, "--seal", &self.seal, "--tree", &tree])
            .args(["--api-base", api, "--lists-sha256"])
            .arg(reverie_publish::sha256_hex(LISTS.as_bytes()))
            .arg("--packet")
            .arg(root.join("packet"))
            .arg("--git-dir")
            .arg(root.join("store.git"))
            .arg("--lists")
            .arg(root.join("lists.json"))
            .arg("--approval")
            .arg(root.join("approval.json"))
            .arg("--records")
            .arg(self.records())
            .arg("--token-file")
            .arg(root.join("token"))
            .args(extra);
        // No request leaves this machine: any https remote goes to a closed local port, while the
        // loopback API is reached directly.
        for proxy in ["https_proxy", "HTTPS_PROXY", "http_proxy", "ALL_PROXY"] {
            command.env(proxy, "http://127.0.0.1:9");
        }
        command
            .env("no_proxy", "127.0.0.1")
            .env("NO_PROXY", "127.0.0.1");
        // The local bare remote, token-free, unless the test names its own.
        for flag in ["--remote-url", "--base-url"] {
            if !extra.contains(&flag) {
                command.arg(flag).arg(self.remote());
            }
        }
        command
    }

    /// Moves `topic` on the remote to a new commit made from `main`.
    fn diverge(&self) -> String {
        let work = self.fixture.work();
        git(&work, &["checkout", "-q", "-b", "elsewhere", "main"]);
        fs::write(work.join("d.txt"), "four\n").unwrap();
        git(&work, &["add", "d.txt"]);
        git(
            &work,
            &["commit", "-q", "-m", &format!("Add d\n\n{SIGNOFF}")],
        );
        git(
            &self.remote(),
            &[
                "fetch",
                "-q",
                work.to_str().unwrap(),
                "+elsewhere:refs/heads/topic",
            ],
        );
        self.branch()
    }
}

fn methods(seen: &Arc<Mutex<Vec<Seen>>>) -> Vec<String> {
    seen.lock()
        .unwrap()
        .iter()
        .map(|s| format!("{} {}", s.method, s.path))
        .collect()
}

#[test]
fn fast_forwards_the_pr_branch_sets_the_text_and_reads_everything_back() {
    let p = prepared("publish");
    let (api, seen) = p.api(SAME_REPO);
    let out = p.run(&api, &p.old, &["--ci-readback"]);
    assert_eq!(out.status.code(), Some(0), "{}", stderr(&out));
    assert_eq!(p.branch(), p.head);
    let summary: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(summary["pushed"], true);
    assert_eq!(summary["fork"], false);
    assert_eq!(summary["ciRuns"], 1);
    let pr = "/repos/owner/demo/pulls/7";
    assert_eq!(
        methods(&seen),
        [
            format!("GET {pr}"),
            format!("PATCH {pr}"),
            format!("GET {pr}"),
            format!(
                "GET /repos/owner/demo/actions/runs?head_sha={}&per_page=10",
                p.head
            ),
        ]
    );
    let patch = seen.lock().unwrap()[1].clone();
    assert_eq!(patch.body, json!({ "title": TITLE, "body": BODY }));
    assert_eq!(patch.authorization, "Bearer testtoken");
    for record in [
        "INTENT.json",
        "PUSH-RESULT.json",
        "PR-TEXT-RESULT.json",
        "PR-READBACK.json",
        "CI-FIRST-READBACK.json",
    ] {
        assert!(p.records().join(record).is_file(), "{record}");
    }
    let intent: Value =
        serde_json::from_slice(&fs::read(p.records().join("INTENT.json")).unwrap()).unwrap();
    assert_eq!(intent["force"], false);
    assert_eq!(intent["old"], json!(p.old));
    // The PR is now at the head, so a repeat refuses before writing anything.
    refused(&p.run(&api, &p.old, &[]), "moved");
}

#[test]
fn a_dry_run_reads_the_pr_and_writes_nothing() {
    let p = prepared("dry");
    let (api, seen) = p.api(SAME_REPO);
    let out = p.run(&api, &p.old, &["--dry"]);
    assert_eq!(out.status.code(), Some(0), "{}", stderr(&out));
    assert_eq!(p.branch(), p.old);
    assert!(!p.records().exists());
    assert_eq!(methods(&seen), ["GET /repos/owner/demo/pulls/7"]);
}

#[test]
fn a_pr_or_branch_that_moved_refuses_before_any_write() {
    let p = prepared("moved");
    let (api, _) = p.api(SAME_REPO);
    refused(&p.run(&api, &p.head, &[]), "the PR's head is not --old");
    // The API still says old, but the branch itself has moved on.
    let (api, _) = p.api(Api {
        head: Some(p.old.clone()),
        ..SAME_REPO
    });
    let moved = p.diverge();
    refused(&p.run(&api, &p.old, &[]), "branch topic is not at --old");
    assert_eq!(p.branch(), moved);
    assert!(!p.records().exists());
}

#[test]
fn a_head_that_does_not_contain_the_branch_refuses() {
    let p = prepared("not-ff");
    let other = p.diverge();
    let (api, _) = p.api(SAME_REPO);
    refused(&p.run(&api, &other, &[]), "not a fast-forward");
    assert_eq!(p.branch(), other);
    assert!(!p.records().exists());
}

#[test]
fn a_fork_head_is_pushed_only_when_maintainers_may_modify_it() {
    let p = prepared("fork");
    let fork = Api {
        head_repo: "zorblat/demo",
        ..SAME_REPO
    };
    let (api, _) = p.api(fork.clone());
    refused(
        &p.run(&api, &p.old, &[]),
        "does not allow maintainer pushes",
    );
    assert_eq!(p.branch(), p.old);
    let (api, _) = p.api(Api {
        can_modify: true,
        ..fork
    });
    let out = p.run(&api, &p.old, &[]);
    assert_eq!(out.status.code(), Some(0), "{}", stderr(&out));
    let summary: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(summary["fork"], true);
    assert_eq!(summary["headRepo"], "zorblat/demo");
    assert_eq!(p.branch(), p.head);
}

#[test]
fn text_that_does_not_read_back_is_reported_after_the_push() {
    let p = prepared("text");
    let (api, _) = p.api(Api {
        accepts_text: false,
        ..SAME_REPO
    });
    refused(&p.run(&api, &p.old, &[]), "does not read back as published");
    assert_eq!(p.branch(), p.head);
    assert!(p.records().join("PR-READBACK.json").is_file());
}

#[test]
fn an_approval_for_another_head_refuses_before_any_write() {
    let p = prepared("approval");
    let stale = p.fixture.approval(&p.old, "main", TITLE, BODY);
    fs::write(p.fixture.root.join("approval.json"), stale.to_string()).unwrap();
    let (api, _) = p.api(SAME_REPO);
    refused(&p.run(&api, &p.old, &[]), "approval");
    assert_eq!(p.branch(), p.old);
    assert!(!p.records().exists());
}

#[test]
fn a_push_url_other_than_the_pr_head_repository_refuses_before_any_write() {
    for url in [
        "https://github.com/zorblat/demo.git",
        "https://foreign.example.invalid/owner/demo.git",
        "https://github.com/owner/demo",
        "ssh://git@github.com/owner/demo.git",
        "relative/remote.git",
    ] {
        let p = prepared("push-url");
        let (api, seen) = p.api(SAME_REPO);
        refused(&p.run(&api, &p.old, &["--remote-url", url]), "--remote-url");
        assert_eq!(p.branch(), p.old, "{url}");
        assert!(!p.records().exists(), "{url}");
        // Only the PR read happened: nothing was written to the API.
        assert_eq!(methods(&seen), ["GET /repos/owner/demo/pulls/7"], "{url}");
    }
}

#[test]
fn a_fork_pr_pushes_only_to_the_fork_not_the_base_repository() {
    let p = prepared("fork-url");
    let (api, seen) = p.api(Api {
        head_repo: "zorblat/demo",
        can_modify: true,
        ..SAME_REPO
    });
    let out = p.run(
        &api,
        &p.old,
        &["--remote-url", "https://github.com/owner/demo.git"],
    );
    refused(&out, "is neither https://github.com/zorblat/demo.git");
    assert_eq!(p.branch(), p.old);
    assert!(!p.records().exists());
    assert_eq!(methods(&seen), ["GET /repos/owner/demo/pulls/7"]);
}

#[test]
fn a_base_url_other_than_the_base_repository_refuses_before_any_write() {
    let p = prepared("base-url");
    let (api, _) = p.api(SAME_REPO);
    refused(
        &p.run(
            &api,
            &p.old,
            &[
                "--base-url",
                "https://foreign.example.invalid/owner/demo.git",
            ],
        ),
        "--base-url",
    );
    assert_eq!(p.branch(), p.old);
    assert!(!p.records().exists());
}

#[test]
fn the_head_repository_url_is_accepted_for_a_fork_and_the_base_repo_alike() {
    // Past the destination check, the fetch reaches only the closed local proxy and fails there.
    for (head_repo, url) in [
        ("owner/demo", "https://github.com/owner/demo.git"),
        ("zorblat/demo", "https://github.com/zorblat/demo.git"),
    ] {
        let p = prepared("head-url");
        let (api, _) = p.api(Api {
            head_repo,
            can_modify: true,
            ..SAME_REPO
        });
        let out = p.run(&api, &p.old, &["--remote-url", url]);
        assert_eq!(out.status.code(), Some(1), "{url}");
        let why = stderr(&out);
        assert!(!why.contains("is neither"), "{url}: {why}");
        assert!(why.contains("git failed"), "{url}: {why}");
        assert!(
            why.contains("over proxy 127.0.0.1"),
            "{url} left this machine: {why}"
        );
        assert_eq!(p.branch(), p.old, "{url}");
        assert!(!p.records().exists(), "{url}");
    }
}

#[test]
fn a_local_remote_is_pushed_without_the_token_wiring() {
    let p = prepared("local-token-free");
    // A git on PATH that notes whether each push was given git's credential prompt helper.
    let real = std::env::split_paths(&std::env::var_os("PATH").unwrap())
        .map(|dir| dir.join("git"))
        .find(|git| git.is_file())
        .unwrap();
    let shim = p.fixture.root.join("shim");
    fs::create_dir(&shim).unwrap();
    let log = p.fixture.root.join("askpass.log");
    let script = format!(
        "#!/bin/sh\ncase \" $* \" in *\" push \"*) if [ -n \"$GIT_ASKPASS\" ]; then echo askpass >> \"{log}\"; else echo none >> \"{log}\"; fi ;; esac\nexec \"{real}\" \"$@\"\n",
        log = log.display(),
        real = real.display(),
    );
    fs::write(shim.join("git"), script).unwrap();
    fs::set_permissions(
        shim.join("git"),
        std::os::unix::fs::PermissionsExt::from_mode(0o755),
    )
    .unwrap();
    let path = std::env::join_paths(
        std::iter::once(shim).chain(std::env::split_paths(&std::env::var_os("PATH").unwrap())),
    )
    .unwrap();
    let (api, _) = p.api(SAME_REPO);
    let out = p
        .command(&api, &p.old, &[])
        .env("PATH", path)
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(0), "{}", stderr(&out));
    assert_eq!(p.branch(), p.head);
    assert_eq!(fs::read_to_string(&log).unwrap(), "none\n");
}
