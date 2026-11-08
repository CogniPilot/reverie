//! The real `reverie-publish pr-text`, `issue-create` and `issue-close` against sealed packets and
//! a loopback server that keeps a small GitHub's worth of state: PR 7, issue 3 and their comments.
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

/// Invented entries only: the gate must block them without any real name in the repository.
const LISTS: &str = r#"{"schema":1,"home_repo":"demo","team":["zorblat"],"internal":["quuxhost"],"ai_words":["robotronix"],"ai_phrases":["made by a machine"],"path_markers":["/opt/hidden-zone/"],"allow":["harmless"]}"#;
const HEAD: &str = "1111111111111111111111111111111111111111";

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

/// The fake's state.
#[derive(Debug)]
struct Hub {
    pr: Value,
    issues: Vec<Value>,
    comments: Vec<(u64, String)>,
    /// When false, writes are answered but change nothing, so readbacks differ.
    applies_writes: bool,
}

impl Hub {
    fn new() -> Self {
        Self {
            pr: json!({
                "number": 7, "state": "open", "merged": false, "title": "Old title",
                "body": "Old body\n", "labels": [], "head": { "sha": HEAD },
                "html_url": "https://example.invalid/pull/7",
            }),
            issues: vec![json!({
                "number": 3, "state": "open", "title": "Existing issue", "body": "x\n",
                "labels": [], "html_url": "https://example.invalid/issues/3",
            })],
            comments: Vec::new(),
            applies_writes: true,
        }
    }

    /// The PR as the issues API shows it.
    fn pr_issue(&self) -> Value {
        let mut issue = self.pr.clone();
        issue["pull_request"] = json!({});
        issue
    }

    fn issue(&mut self, number: u64) -> Option<&mut Value> {
        self.issues.iter_mut().find(|i| i["number"] == number)
    }

    fn reply(&mut self, seen: &Seen) -> (u16, Value) {
        let path = seen.path.strip_prefix("/repos/owner/demo").unwrap_or("");
        let apply = self.applies_writes;
        match (seen.method.as_str(), path) {
            ("GET", "/pulls/7") => (200, self.pr.clone()),
            ("PATCH", "/pulls/7") => {
                let keys = ["title", "body"].into_iter();
                for key in keys.filter(|key| apply && seen.body.get(key).is_some()) {
                    self.pr[key] = seen.body[key].clone();
                }
                (200, self.pr.clone())
            }
            ("PUT", "/issues/7/labels") => {
                let labels: Vec<Value> = seen.body["labels"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|name| json!({ "name": name }))
                    .collect();
                if apply {
                    self.pr["labels"] = json!(labels);
                }
                (200, json!(labels))
            }
            ("GET", "/issues?state=open&per_page=100") => {
                let mut open: Vec<Value> = self
                    .issues
                    .iter()
                    .filter(|i| i["state"] == "open")
                    .cloned()
                    .collect();
                open.push(self.pr_issue());
                (200, json!(open))
            }
            ("POST", "/issues") => {
                let mut issue = seen.body.clone();
                issue["number"] = json!(9);
                issue["state"] = json!("open");
                issue["html_url"] = json!("https://example.invalid/issues/9");
                let names = issue["labels"].as_array().cloned().unwrap_or_default();
                issue["labels"] =
                    json!(names.iter().map(|n| json!({"name": n})).collect::<Vec<_>>());
                if apply {
                    self.issues.push(issue.clone());
                }
                (201, issue)
            }
            ("GET", "/issues/7") => (200, self.pr_issue()),
            ("GET", other) if other.ends_with("/comments?per_page=100") => {
                let number: u64 = other.split('/').nth(2).unwrap().parse().unwrap();
                let list: Vec<Value> = self
                    .comments
                    .iter()
                    .filter(|(n, _)| *n == number)
                    .map(|(_, body)| json!({ "body": body }))
                    .collect();
                (200, json!(list))
            }
            ("POST", other) if other.ends_with("/comments") => {
                let number: u64 = other.split('/').nth(2).unwrap().parse().unwrap();
                let body = seen.body["body"].as_str().unwrap().to_owned();
                if apply {
                    self.comments.push((number, body.clone()));
                }
                (201, json!({ "body": body }))
            }
            ("PATCH", "/issues/7") => {
                if apply {
                    self.pr["state"] = json!("closed");
                }
                (200, self.pr_issue())
            }
            ("GET" | "PATCH", other) if other.starts_with("/issues/") => {
                let number: u64 = other.trim_start_matches("/issues/").parse().unwrap_or(0);
                let close = (seen.method == "PATCH" && apply).then(|| seen.body["state"].clone());
                let Some(issue) = self.issue(number) else {
                    return (404, json!({ "message": "Not Found" }));
                };
                if let Some(state) = close {
                    issue["state"] = state;
                }
                (200, issue.clone())
            }
            _ => (404, json!({ "message": "Not Found" })),
        }
    }
}

type Shared = Arc<Mutex<(Hub, Vec<Seen>)>>;

fn serve(hub: Hub) -> (String, Shared) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
    let state: Shared = Arc::new(Mutex::new((hub, Vec::new())));
    let shared = Arc::clone(&state);
    thread::spawn(move || {
        for stream in listener.incoming() {
            let mut stream = stream.unwrap();
            let seen = read_request(&stream);
            let (status, answer) = {
                let mut state = shared.lock().unwrap();
                let reply = state.0.reply(&seen);
                state.1.push(seen);
                reply
            };
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

fn writes(state: &Shared) -> Vec<String> {
    state
        .lock()
        .unwrap()
        .1
        .iter()
        .filter(|s| s.method != "GET")
        .map(|s| format!("{} {}", s.method, s.path))
        .collect()
}

/// A scratch root with a sealed packet of `files`, the lists, a token and an approval.
struct Case {
    root: PathBuf,
    seal: String,
}

impl Drop for Case {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

impl Case {
    fn new(name: &str, files: &[(&str, &str)]) -> Self {
        let root = std::env::temp_dir().join(format!("publish-text-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let packet = root.join("packet");
        fs::create_dir_all(&packet).unwrap();
        let mut sums = String::new();
        for (file, content) in files {
            fs::write(packet.join(file), content).unwrap();
            sums.push_str(&format!("{}  {file}\n", sha256_hex(content.as_bytes())));
        }
        fs::write(packet.join("SHA256SUMS"), &sums).unwrap();
        fs::write(root.join("lists.json"), LISTS).unwrap();
        fs::write(root.join("token"), "testtoken\n").unwrap();
        Self {
            seal: sha256_hex(sums.as_bytes())[..8].to_owned(),
            root,
        }
    }

    /// Writes an approval for `action` covering `files` (by the packet's own names).
    fn approve(
        &self,
        action: &str,
        number: Option<u64>,
        head: Option<&str>,
        files: &[(&str, &str)],
    ) {
        let sha = |name: &str| {
            files
                .iter()
                .find(|(f, _)| *f == name)
                .map(|(_, content)| piece_sha(name, content))
        };
        let record = json!({
            "publicationAuthorized": true,
            "repo": "owner/demo",
            "action": action,
            "number": number,
            "head": head,
            "titleSha256": sha("TITLE.txt"),
            "bodySha256": sha("BODY.md"),
            "commentSha256": sha("COMMENT.md"),
            "labelsSha256": sha("LABELS.txt"),
            "reviews": ["text GO 0000aaaa"],
        });
        fs::write(self.root.join("approval.json"), record.to_string()).unwrap();
    }

    fn records(&self) -> PathBuf {
        self.root.join("records")
    }

    fn run(&self, api: &str, action: &str, extra: &[&str]) -> Output {
        let root = &self.root;
        Command::new(env!("CARGO_BIN_EXE_reverie-publish"))
            .args([
                action,
                "--repo",
                "owner/demo",
                "--seal",
                &self.seal,
                "--api-base",
                api,
            ])
            .args(["--lists-sha256", &sha256_hex(LISTS.as_bytes())])
            .arg("--packet")
            .arg(root.join("packet"))
            .arg("--lists")
            .arg(root.join("lists.json"))
            .arg("--approval")
            .arg(root.join("approval.json"))
            .arg("--records")
            .arg(self.records())
            .arg("--token-file")
            .arg(root.join("token"))
            .args(extra)
            .output()
            .unwrap()
    }
}

/// The hash an approval names: the title's first line trimmed, anything else exactly.
fn piece_sha(name: &str, content: &str) -> String {
    match name {
        "TITLE.txt" => sha256_hex(content.lines().next().unwrap_or("").trim().as_bytes()),
        _ => sha256_hex(content.as_bytes()),
    }
}

fn stderr(out: &Output) -> String {
    String::from_utf8_lossy(&out.stderr).into_owned()
}

fn passes(out: &Output) -> Value {
    assert_eq!(out.status.code(), Some(0), "{}", stderr(out));
    serde_json::from_slice(&out.stdout).unwrap()
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

const PR_FILES: [(&str, &str); 3] = [
    ("TITLE.txt", "New title\n"),
    ("BODY.md", "New body.\n"),
    ("LABELS.txt", "bug\nspeed\n"),
];

#[test]
fn pr_text_sets_title_body_and_labels_and_reads_them_back() {
    let case = Case::new("pr-text", &PR_FILES);
    case.approve("pr-text", Some(7), Some(HEAD), &PR_FILES);
    let (api, state) = serve(Hub::new());
    let summary = passes(&case.run(&api, "pr-text", &["--pr", "7", "--head", HEAD]));
    assert_eq!(summary["published"], true);
    assert_eq!(
        writes(&state),
        [
            "PATCH /repos/owner/demo/pulls/7",
            "PUT /repos/owner/demo/issues/7/labels"
        ]
    );
    let pr = state.lock().unwrap().0.pr.clone();
    assert_eq!(pr["title"], "New title");
    assert_eq!(pr["body"], "New body.\n");
    has(
        &case.records(),
        &[
            "INTENT.json",
            "PR-TEXT-RESULT.json",
            "LABELS-RESULT.json",
            "PR-READBACK.json",
        ],
    );
    refused(
        &case.run(&api, "pr-text", &["--pr", "7", "--head", HEAD]),
        "inspect the earlier attempt",
    );
}

#[test]
fn a_dry_run_reads_and_writes_nothing() {
    let case = Case::new("dry", &PR_FILES);
    case.approve("pr-text", Some(7), Some(HEAD), &PR_FILES);
    let (api, state) = serve(Hub::new());
    passes(&case.run(&api, "pr-text", &["--pr", "7", "--head", HEAD, "--dry"]));
    assert!(writes(&state).is_empty());
    assert!(!case.records().exists());
}

#[test]
fn a_moved_pr_or_an_approval_for_other_text_refuses_before_any_write() {
    let case = Case::new("refuse", &PR_FILES);
    let (api, state) = serve(Hub::new());
    let moved = "2222222222222222222222222222222222222222";
    case.approve("pr-text", Some(7), Some(moved), &PR_FILES);
    refused(
        &case.run(&api, "pr-text", &["--pr", "7", "--head", moved]),
        "it moved",
    );
    let other = [
        ("TITLE.txt", "New title\n"),
        ("BODY.md", "Other body.\n"),
        PR_FILES[2],
    ];
    case.approve("pr-text", Some(7), Some(HEAD), &other);
    refused(
        &case.run(&api, "pr-text", &["--pr", "7", "--head", HEAD]),
        "does not cover this body",
    );
    case.approve("issue-close", Some(7), Some(HEAD), &PR_FILES);
    refused(
        &case.run(&api, "pr-text", &["--pr", "7", "--head", HEAD]),
        "is for issue-close",
    );
    assert!(writes(&state).is_empty());
    assert!(!case.records().exists());
}

#[test]
fn a_blocked_name_in_the_text_refuses() {
    let files = [("TITLE.txt", "Fix\n"), ("BODY.md", "Thanks zorblat.\n")];
    let case = Case::new("namegate", &files);
    case.approve("pr-text", Some(7), Some(HEAD), &files);
    let (api, state) = serve(Hub::new());
    refused(
        &case.run(&api, "pr-text", &["--pr", "7", "--head", HEAD]),
        "the text",
    );
    assert!(writes(&state).is_empty());
}

#[test]
fn text_that_does_not_read_back_is_reported() {
    let case = Case::new("readback", &PR_FILES);
    case.approve("pr-text", Some(7), Some(HEAD), &PR_FILES);
    let mut hub = Hub::new();
    hub.applies_writes = false;
    let (api, _) = serve(hub);
    refused(
        &case.run(&api, "pr-text", &["--pr", "7", "--head", HEAD]),
        "does not read back as published",
    );
    has(&case.records(), &["PR-READBACK.json"]);
}

#[test]
fn an_issue_is_created_and_read_back_unless_its_title_is_taken() {
    let files = [
        ("TITLE.txt", "Follow up\n"),
        ("BODY.md", "Details.\n"),
        ("LABELS.txt", "bug\n"),
    ];
    let case = Case::new("create", &files);
    case.approve("issue-create", None, None, &files);
    let (api, state) = serve(Hub::new());
    let summary = passes(&case.run(&api, "issue-create", &[]));
    assert_eq!(summary["number"], 9);
    assert_eq!(writes(&state), ["POST /repos/owner/demo/issues"]);
    has(
        &case.records(),
        &["INTENT.json", "ISSUE-RESULT.json", "ISSUE-READBACK.json"],
    );

    let taken = [("TITLE.txt", "Existing issue\n"), ("BODY.md", "Again.\n")];
    let case = Case::new("taken", &taken);
    case.approve("issue-create", None, None, &taken);
    let (api, state) = serve(Hub::new());
    refused(
        &case.run(&api, "issue-create", &[]),
        "already has this title",
    );
    assert!(writes(&state).is_empty());
}

#[test]
fn an_issue_is_commented_and_closed_and_a_repeat_comment_refuses() {
    let files = [("COMMENT.md", "Done in a later change.\n")];
    let case = Case::new("close-issue", &files);
    case.approve("issue-close", Some(3), None, &files);
    let (api, state) = serve(Hub::new());
    passes(&case.run(&api, "issue-close", &["--number", "3"]));
    assert_eq!(
        writes(&state),
        [
            "POST /repos/owner/demo/issues/3/comments",
            "PATCH /repos/owner/demo/issues/3"
        ]
    );
    has(
        &case.records(),
        &[
            "INTENT.json",
            "COMMENT-RESULT.json",
            "CLOSE-RESULT.json",
            "CLOSE-READBACK.json",
        ],
    );
    // The same comment already on an open issue refuses before anything is written.
    let again = Case::new("close-again", &files);
    again.approve("issue-close", Some(3), None, &files);
    let mut hub = Hub::new();
    hub.comments.push((3, files[0].1.to_owned()));
    let (api, state) = serve(hub);
    refused(
        &again.run(&api, "issue-close", &["--number", "3"]),
        "already there",
    );
    assert!(writes(&state).is_empty());
}

#[test]
fn a_pr_is_closed_unmerged_only_at_its_head() {
    let files = [("COMMENT.md", "Superseded.\n")];
    let case = Case::new("close-pr", &files);
    case.approve("issue-close", Some(7), None, &files);
    let (api, state) = serve(Hub::new());
    refused(
        &case.run(&api, "issue-close", &["--number", "7"]),
        "--head is required",
    );
    case.approve("issue-close", Some(7), Some(HEAD), &files);
    let summary = passes(&case.run(&api, "issue-close", &["--number", "7", "--head", HEAD]));
    assert_eq!(summary["pr"], true);
    let pr = state.lock().unwrap().0.pr.clone();
    assert_eq!(pr["state"], "closed");
    assert_eq!(pr["merged"], false);
    has(&case.records(), &["PR-READBACK.json"]);
}
