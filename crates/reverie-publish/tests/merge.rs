//! The real `reverie-publish merge` against a throwaway repository and sealed packet, and a
//! loopback server holding a small GitHub's worth of state for PR 7: its checks, comments and
//! reviews, and the merge itself.
use reverie_publish::sha256_hex;
use serde_json::{Value, json};
use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Command, Output},
    sync::{Arc, Mutex},
    thread,
};

const SIGNOFF: &str = "Signed-off-by: James Goppert <jgoppert@users.noreply.github.com>";
/// Invented entries only: the gate must block them without any real name in the repository.
const LISTS: &str = r#"{"schema":1,"home_repo":"demo","team":["zorblat"],"internal":["quuxhost"],"ai_words":["robotronix"],"ai_phrases":["made by a machine"],"path_markers":["/opt/hidden-zone/"],"allow":["harmless"]}"#;
const TITLE: &str = "Add b";
const BODY: &str = "Adds b.\n";
const MERGE_SHA: &str = "4444444444444444444444444444444444444444";

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

fn bytes(dir: &Path, args: &[&str]) -> Vec<u8> {
    Command::new("git")
        .args(args)
        .current_dir(dir)
        .output()
        .unwrap()
        .stdout
}

/// A work repository with `main` and a reviewed `topic` commit, a store holding `main`, a sealed
/// packet for `topic`, the lists, a token and an approval record that names PR 7.
struct Case {
    root: PathBuf,
    seal: String,
    head: String,
    base: String,
}

impl Drop for Case {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

impl Case {
    fn new(name: &str) -> Self {
        let root =
            std::env::temp_dir().join(format!("publish-merge-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let (work, packet) = (root.join("work"), root.join("packet"));
        fs::create_dir_all(&work).unwrap();
        fs::create_dir_all(&packet).unwrap();
        fs::create_dir_all(root.join("scratch")).unwrap();
        git(&work, &["init", "-q"]);
        fs::write(work.join("a.txt"), "one\n").unwrap();
        git(&work, &["add", "a.txt"]);
        git(
            &work,
            &["commit", "-q", "-m", &format!("Base\n\n{SIGNOFF}")],
        );
        let base = git(&work, &["rev-parse", "HEAD"]);
        git(&work, &["checkout", "-q", "-b", "topic"]);
        fs::write(work.join("b.txt"), "two\n").unwrap();
        git(&work, &["add", "b.txt"]);
        git(
            &work,
            &["commit", "-q", "-m", &format!("{TITLE}\n\n{SIGNOFF}")],
        );
        let head = git(&work, &["rev-parse", "HEAD"]);
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
        let bundle = packet.join("source.bundle");
        git(
            &work,
            &[
                "bundle",
                "create",
                "-q",
                bundle.to_str().unwrap(),
                "main..topic",
            ],
        );
        fs::write(packet.join("TITLE.txt"), format!("{TITLE}\n")).unwrap();
        fs::write(packet.join("BODY.md"), BODY).unwrap();
        let mut sums = String::new();
        for file in ["BODY.md", "TITLE.txt", "source.bundle"] {
            sums.push_str(&format!(
                "{}  {file}\n",
                sha256_hex(&fs::read(packet.join(file)).unwrap())
            ));
        }
        fs::write(packet.join("SHA256SUMS"), &sums).unwrap();
        fs::write(root.join("lists.json"), LISTS).unwrap();
        fs::write(root.join("token"), "testtoken\n").unwrap();
        let case = Self {
            seal: sha256_hex(sums.as_bytes())[..8].to_owned(),
            root,
            head,
            base,
        };
        case.approve(Some(7));
        case
    }

    /// Writes the approval record, naming `merge_pr` when given.
    fn approve(&self, merge_pr: Option<u64>) {
        let work = self.root.join("work");
        let mut record = json!({
            "publicationAuthorized": true,
            "repo": "owner/demo",
            "head": self.head,
            "tree": git(&work, &["rev-parse", &format!("{}^{{tree}}", self.head)]),
            "rawCommitSha256": sha256_hex(&bytes(&work, &["cat-file", "commit", &self.head])),
            "base": self.base,
            "patchSha256": sha256_hex(&bytes(&work, &["diff", "--binary", "--full-index", &self.base, &self.head])),
            "titleSha256": sha256_hex(TITLE.as_bytes()),
            "bodySha256": sha256_hex(BODY.as_bytes()),
            "reviews": ["source GO 0000aaaa"],
        });
        if let Some(pr) = merge_pr {
            record["mergePr"] = json!(pr);
            record["mergeBaseBranch"] = json!("main");
        }
        fs::write(self.root.join("approval.json"), record.to_string()).unwrap();
    }

    fn records(&self) -> PathBuf {
        self.root.join("records")
    }

    fn run(&self, api: &str, extra: &[&str]) -> Output {
        let root = &self.root;
        let tree = git(
            &root.join("work"),
            &["rev-parse", &format!("{}^{{tree}}", self.head)],
        );
        Command::new(env!("CARGO_BIN_EXE_reverie-publish"))
            .args([
                "merge",
                "--repo",
                "owner/demo",
                "--base",
                "refs/heads/main",
                "--head",
                &self.head,
            ])
            .args([
                "--seal",
                &self.seal,
                "--tree",
                &tree[..12],
                "--pr",
                "7",
                "--api-base",
                api,
            ])
            .args(["--lists-sha256", &sha256_hex(LISTS.as_bytes())])
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
            .arg("--scratch")
            .arg(root.join("scratch"))
            .args(extra)
            .output()
            .unwrap()
    }
}

/// One request: method, path and JSON body.
#[derive(Debug, Clone)]
struct Seen {
    method: String,
    path: String,
    body: Value,
}

fn read_request(stream: &TcpStream) -> Seen {
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let mut line = String::new();
    reader.read_line(&mut line).unwrap();
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or("").to_owned();
    let path = parts.next().unwrap_or("").to_owned();
    let mut length = 0;
    for header in reader.by_ref().lines().map(Result::unwrap) {
        if header.is_empty() {
            break;
        }
        let (name, value) = header.split_once(':').unwrap_or((&header, ""));
        if name.eq_ignore_ascii_case("content-length") {
            length = value.trim().parse().unwrap();
        }
    }
    let mut body = vec![0; length];
    reader.read_exact(&mut body).unwrap();
    Seen {
        method,
        path,
        body: serde_json::from_slice(&body).unwrap_or(Value::Null),
    }
}

/// Alters a reply in place before it is sent.
type Rewrite = fn(&Seen, &mut Value);

/// The fake's state: PR 7 at `head`, one passing check run, no statuses, one comment and review.
struct Hub {
    pr: Value,
    base: String,
    comments: Value,
    reviews: Value,
    runs: Value,
    rewrite: Option<Rewrite>,
}

impl Hub {
    fn new(case: &Case) -> Self {
        Self {
            pr: json!({
                "number": 7, "state": "open", "merged": false, "draft": false, "title": TITLE,
                "body": BODY, "head": { "sha": case.head }, "mergeable": true,
                "mergeable_state": "clean", "merge_commit_sha": null,
                "base": { "ref": "main", "sha": case.base, "repo": { "full_name": "owner/demo" } },
            }),
            base: case.base.clone(),
            comments: json!([{ "id": 1, "body": "Looks good." }]),
            reviews: json!([{ "id": 2, "body": "Approved." }]),
            runs: json!([{ "name": "image", "head_sha": case.head, "status": "completed", "conclusion": "success" }]),
            rewrite: None,
        }
    }

    fn reply(&mut self, seen: &Seen) -> (u16, Value) {
        let path = seen.path.strip_prefix("/repos/owner/demo").unwrap_or("");
        let head = self.pr["head"]["sha"].as_str().unwrap().to_owned();
        match (seen.method.as_str(), path) {
            ("GET", "/pulls/7") => (200, self.pr.clone()),
            ("GET", "/issues/7/comments?per_page=100") => (200, self.comments.clone()),
            ("GET", "/pulls/7/reviews?per_page=100") => (200, self.reviews.clone()),
            ("GET", "/pulls/7/comments?per_page=100") => (200, json!([])),
            ("GET", p) if p == format!("/commits/{head}/check-runs?per_page=100") => {
                let runs = self.runs.as_array().unwrap().len();
                (200, json!({ "total_count": runs, "check_runs": self.runs }))
            }
            ("GET", p) if p == format!("/commits/{head}/status") => (
                200,
                json!({ "state": "pending", "total_count": 0, "statuses": [] }),
            ),
            ("PUT", "/pulls/7/merge") => {
                if seen.body["sha"] != head.as_str() {
                    return (409, json!({ "message": "Head branch was modified" }));
                }
                self.pr["merged"] = json!(true);
                self.pr["state"] = json!("closed");
                self.pr["merge_commit_sha"] = json!(MERGE_SHA);
                (
                    200,
                    json!({ "merged": true, "sha": MERGE_SHA, "message": "Pull Request successfully merged" }),
                )
            }
            ("GET", p) if p == format!("/commits/{MERGE_SHA}") => (
                200,
                json!({ "sha": MERGE_SHA, "parents": [{ "sha": self.base }, { "sha": head }] }),
            ),
            _ => (404, json!({ "message": "Not Found" })),
        }
    }
}

type Shared = Arc<Mutex<(Hub, Vec<Seen>)>>;

/// The hub's reply to `seen`, after any rewrite; the request is kept for the test to inspect.
fn answer(shared: &Shared, seen: Seen) -> (u16, Value) {
    let mut state = shared.lock().unwrap();
    let mut reply = state.0.reply(&seen);
    if let Some(rewrite) = state.0.rewrite {
        rewrite(&seen, &mut reply.1);
    }
    state.1.push(seen);
    reply
}

fn serve(hub: Hub) -> (String, Shared) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
    let state: Shared = Arc::new(Mutex::new((hub, Vec::new())));
    let shared = Arc::clone(&state);
    thread::spawn(move || {
        for stream in listener.incoming() {
            let mut stream = stream.unwrap();
            let seen = read_request(&stream);
            let (status, answer) = answer(&shared, seen);
            let answer = answer.to_string();
            write!(
                stream,
                "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{answer}",
                answer.len()
            )
            .unwrap();
        }
    });
    (base, state)
}

fn requests(state: &Shared) -> Vec<Seen> {
    state.lock().unwrap().1.clone()
}

fn writes(state: &Shared) -> Vec<String> {
    requests(state)
        .iter()
        .filter(|s| s.method != "GET")
        .map(|s| format!("{} {}", s.method, s.path))
        .collect()
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

fn has(dir: &Path, names: &[&str]) {
    for name in names {
        assert!(dir.join(name).is_file(), "{name}");
    }
}

/// Runs the merge against a hub with `rewrite` and expects a refusal before any write.
fn refuses_before_writing(name: &str, rewrite: Rewrite, why: &str) {
    let case = Case::new(name);
    let mut hub = Hub::new(&case);
    hub.rewrite = Some(rewrite);
    let (api, state) = serve(hub);
    refused(&case.run(&api, &[]), why);
    assert!(writes(&state).is_empty(), "{name}");
    assert!(!case.records().exists(), "{name}");
}

#[test]
fn a_ready_pr_is_merged_with_a_merge_commit_and_read_back() {
    let case = Case::new("clean");
    let (api, state) = serve(Hub::new(&case));
    let out = case.run(&api, &[]);
    assert_eq!(out.status.code(), Some(0), "{}", stderr(&out));
    let summary: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(summary["merged"], true);
    assert_eq!(summary["mergeCommit"], MERGE_SHA);
    assert_eq!(writes(&state), ["PUT /repos/owner/demo/pulls/7/merge"]);
    let put = requests(&state)
        .into_iter()
        .find(|s| s.method == "PUT")
        .unwrap();
    assert_eq!(
        put.body,
        json!({ "merge_method": "merge", "sha": case.head })
    );
    has(
        &case.records(),
        &[
            "INTENT.json",
            "MERGE-RESULT.json",
            "PR-READBACK.json",
            "MERGE-COMMIT-READBACK.json",
        ],
    );
    // A second attempt refuses: the PR now reads back merged, and nothing more is written.
    refused(&case.run(&api, &[]), "not open and unmerged");
    assert_eq!(writes(&state).len(), 1);
}

#[test]
fn a_dry_run_reads_and_writes_nothing() {
    let case = Case::new("dry");
    let (api, state) = serve(Hub::new(&case));
    let out = case.run(&api, &["--dry"]);
    assert_eq!(out.status.code(), Some(0), "{}", stderr(&out));
    assert!(writes(&state).is_empty());
    assert!(!case.records().exists());
}

#[test]
fn only_an_approval_that_names_this_pr_authorizes_a_merge() {
    let case = Case::new("approval");
    let (api, state) = serve(Hub::new(&case));
    case.approve(None);
    refused(&case.run(&api, &[]), "does not authorize merging PR 7");
    case.approve(Some(8));
    refused(&case.run(&api, &[]), "does not authorize merging PR 7");
    assert!(
        requests(&state).is_empty(),
        "nothing is asked of GitHub without the approval"
    );
    assert!(!case.records().exists());
}

#[test]
fn a_merge_approval_must_name_the_branch_it_targets() {
    let case = Case::new("approval-branch");
    let (api, state) = serve(Hub::new(&case));
    let approval = case.root.join("approval.json");
    let mut record: Value = serde_json::from_slice(&fs::read(&approval).unwrap()).unwrap();
    record.as_object_mut().unwrap().remove("mergeBaseBranch");
    fs::write(&approval, record.to_string()).unwrap();
    refused(
        &case.run(&api, &[]),
        "does not name the branch the merge targets",
    );
    assert!(requests(&state).is_empty());
    assert!(!case.records().exists());
}

/// A commit other than the approved base, for a PR whose base is somewhere else.
const OTHER_BASE: &str = "5555555555555555555555555555555555555555";

#[test]
fn a_pr_that_targets_another_branch_or_base_refuses_before_writing() {
    // Retargeted to another branch at another commit, and main moved on. The head,
    // title, body, checks, packet and approval are all the reviewed ones.
    let cases: [(&str, Rewrite, &str); 4] = [
        (
            "retargeted",
            |s, r| {
                if s.path.ends_with("/pulls/7") {
                    r["base"]["ref"] = json!("release");
                    r["base"]["sha"] = json!(OTHER_BASE);
                }
            },
            "targets release, not the approved branch main",
        ),
        (
            "moved-base",
            |s, r| {
                if s.path.ends_with("/pulls/7") {
                    r["base"]["sha"] = json!(OTHER_BASE);
                }
            },
            "not at the approved base",
        ),
        (
            "missing-base",
            |s, r| {
                if s.path.ends_with("/pulls/7") {
                    r.as_object_mut().unwrap().remove("base");
                }
            },
            "the PR's base is not in owner/demo",
        ),
        (
            "other-repo",
            |s, r| {
                if s.path.ends_with("/pulls/7") {
                    r["base"]["repo"]["full_name"] = json!("fork/demo");
                }
            },
            "the PR's base is not in owner/demo",
        ),
    ];
    for (name, rewrite, why) in cases {
        refuses_before_writing(name, rewrite, why);
    }
}

#[test]
fn a_base_that_moves_after_the_checks_is_reported_never_as_the_reviewed_merge() {
    // The PR reads at the approved base, so the merge is sent; GitHub conditions it on the head
    // only, and the commit comes back on another first parent. The merge is reported as not the
    // reviewed operation, with every record kept, and nothing is retried.
    let case = Case::new("base-moved-after");
    let mut hub = Hub::new(&case);
    hub.rewrite = Some(|s, r| {
        if s.path.ends_with(MERGE_SHA) {
            r["parents"][0]["sha"] = json!(OTHER_BASE);
        }
    });
    let (api, state) = serve(hub);
    refused(
        &case.run(&api, &[]),
        "onto a base other than the approved one",
    );
    assert_eq!(writes(&state), ["PUT /repos/owner/demo/pulls/7/merge"]);
    has(
        &case.records(),
        &[
            "INTENT.json",
            "MERGE-RESULT.json",
            "PR-READBACK.json",
            "MERGE-COMMIT-READBACK.json",
        ],
    );
    let intent: Value =
        serde_json::from_slice(&fs::read(case.records().join("INTENT.json")).unwrap()).unwrap();
    assert_eq!(intent["baseBranch"], "main");
    assert_eq!(intent["base"], json!(case.base));
}

#[test]
fn a_failing_packet_check_or_a_foreign_api_base_refuses_before_any_request() {
    let case = Case::new("packet");
    let (api, state) = serve(Hub::new(&case));
    fs::write(case.root.join("packet/BODY.md"), "Edited after sealing.\n").unwrap();
    refused(&case.run(&api, &[]), "BODY.md");
    assert!(requests(&state).is_empty());
    let case = Case::new("api-base");
    refused(
        &case.run("https://example.invalid", &[]),
        "the API base must be",
    );
}

#[test]
fn a_pr_that_is_not_ready_refuses_before_writing() {
    let cases: [(&str, Rewrite, &str); 5] = [
        (
            "blocked",
            |s, r| {
                if s.path.ends_with("/pulls/7") {
                    r["mergeable_state"] = json!("blocked")
                }
            },
            "mergeable_state is blocked",
        ),
        (
            "moved",
            |s, r| {
                if s.path.ends_with("/pulls/7") {
                    r["head"]["sha"] = json!("5555555555555555555555555555555555555555")
                }
            },
            "it moved",
        ),
        (
            "draft",
            |s, r| {
                if s.path.ends_with("/pulls/7") {
                    r["draft"] = json!(true)
                }
            },
            "a draft",
        ),
        (
            "retitled",
            |s, r| {
                if s.path.ends_with("/pulls/7") {
                    r["title"] = json!("Other")
                }
            },
            "not the reviewed text",
        ),
        (
            "renumbered",
            |s, r| {
                if s.path.ends_with("/pulls/7") {
                    r["number"] = json!(8)
                }
            },
            "reads back as number 8",
        ),
    ];
    for (name, rewrite, why) in cases {
        refuses_before_writing(name, rewrite, why);
    }
}

#[test]
fn a_check_that_did_not_pass_on_the_head_refuses_before_writing() {
    let cases: [(&str, Rewrite, &str); 3] = [
        (
            "failed-run",
            |s, r| {
                if s.path.contains("/check-runs") {
                    r["check_runs"][0]["conclusion"] = json!("failure")
                }
            },
            "concluded failure",
        ),
        (
            "running",
            |s, r| {
                if s.path.contains("/check-runs") {
                    r["check_runs"][0]["status"] = json!("in_progress")
                }
            },
            "has not completed",
        ),
        (
            "status",
            |s, r| {
                if s.path.ends_with("/status") {
                    *r = json!({ "state": "failure", "total_count": 1 })
                }
            },
            "combined status is failure",
        ),
    ];
    for (name, rewrite, why) in cases {
        refuses_before_writing(name, rewrite, why);
    }
}

#[test]
fn a_blocked_name_in_a_comment_or_review_refuses_before_writing() {
    refuses_before_writing(
        "comment-name",
        |s, r| {
            if s.path.contains("/issues/7/comments") {
                r[0]["body"] = json!("Thanks zorblat.")
            }
        },
        "rule 8: comment 1",
    );
    refuses_before_writing(
        "review-name",
        |s, r| {
            if s.path.contains("/reviews") {
                r[0]["body"] = json!("Polished by robotronix.")
            }
        },
        "rule 8: review 2",
    );
}

#[test]
fn a_merge_that_does_not_read_back_as_a_merge_commit_of_the_head_is_reported() {
    let cases: [(&str, Rewrite, &str); 3] = [
        (
            "squash",
            |s, r| {
                if s.path.ends_with(MERGE_SHA) {
                    r["parents"] = json!([r["parents"][0].clone()])
                }
            },
            "inspect MERGE-COMMIT-READBACK.json",
        ),
        (
            "not-merged",
            |s, r| {
                if s.method == "PUT" {
                    r["merged"] = json!(false)
                }
            },
            "did not report a merge",
        ),
        (
            "other-commit",
            |s, r| {
                if s.method == "GET" && s.path.ends_with("/pulls/7") && r["merged"] == true {
                    r["merge_commit_sha"] = json!("6666666666666666666666666666666666666666")
                }
            },
            "inspect PR-READBACK.json",
        ),
    ];
    for (name, rewrite, why) in cases {
        let case = Case::new(name);
        let mut hub = Hub::new(&case);
        hub.rewrite = Some(rewrite);
        let (api, state) = serve(hub);
        refused(&case.run(&api, &[]), why);
        assert_eq!(
            writes(&state),
            ["PUT /repos/owner/demo/pulls/7/merge"],
            "{name}"
        );
        has(&case.records(), &["INTENT.json", "MERGE-RESULT.json"]);
    }
}

#[test]
fn records_swapped_at_the_approval_path_never_combine_into_a_merge() {
    // A names PR 7 but approves another head; B approves the exact publication but no merge.
    // Each alone refuses before any request. A FIFO hands A to a reader and, before that read
    // ends, puts B at the same path: a second read of the path would combine the two.
    let case = Case::new("approval-swap");
    let approval = case.root.join("approval.json");
    let (api, state) = serve(Hub::new(&case));
    case.approve(None);
    let publication_only = fs::read(&approval).unwrap();
    let work = case.root.join("work");
    let mut wrong_target: Value = serde_json::from_slice(&publication_only).unwrap();
    wrong_target["mergePr"] = json!(7);
    wrong_target["mergeBaseBranch"] = json!("main");
    wrong_target["head"] = json!(case.base);
    wrong_target["tree"] = json!(git(
        &work,
        &["rev-parse", &format!("{}^{{tree}}", case.base)]
    ));
    wrong_target["rawCommitSha256"] = json!(sha256_hex(&bytes(
        &work,
        &["cat-file", "commit", &case.base]
    )));
    wrong_target["patchSha256"] = json!(sha256_hex(&bytes(
        &work,
        &["diff", "--binary", "--full-index", &case.base, &case.base]
    )));
    let merge_wrong_target = wrong_target.to_string().into_bytes();
    fs::write(&approval, &merge_wrong_target).unwrap();
    refused(&case.run(&api, &[]), "another head");
    fs::write(&approval, &publication_only).unwrap();
    refused(&case.run(&api, &[]), "does not authorize merging PR 7");
    assert!(requests(&state).is_empty());
    fs::remove_file(&approval).unwrap();
    nix::unistd::mkfifo(
        &approval,
        nix::sys::stat::Mode::S_IRUSR | nix::sys::stat::Mode::S_IWUSR,
    )
    .unwrap();
    let swap_path = approval.clone();
    let writer = thread::spawn(move || {
        let mut fifo = fs::OpenOptions::new().write(true).open(&swap_path).unwrap();
        fifo.write_all(&merge_wrong_target).unwrap();
        fs::rename(&swap_path, swap_path.with_extension("held-fifo")).unwrap();
        fs::write(&swap_path, &publication_only).unwrap();
        drop(fifo);
    });
    let out = case.run(&api, &[]);
    writer.join().unwrap();
    // The one record read (A) refuses on its own head; nothing reaches GitHub.
    refused(&out, "another head");
    assert!(writes(&state).is_empty());
    assert!(!case.records().exists());
}
