//! The real `reverie-publish new-pr` against a local bare remote and a loopback server standing in
//! for GitHub's API.
mod common;

use common::*;
use serde_json::{Value, json};
use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    net::{TcpListener, TcpStream},
    path::PathBuf,
    process::{Command, Output},
    sync::{Arc, Mutex},
    thread,
};

/// One request the fake API received: method, path, Authorization header and JSON body.
#[derive(Debug, Clone)]
struct Seen {
    method: String,
    path: String,
    authorization: String,
    body: Value,
}

/// Reads one HTTP request: method, path, Authorization header and JSON body.
fn read_request(stream: &TcpStream) -> Seen {
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let mut line = String::new();
    reader.read_line(&mut line).unwrap();
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or("").to_owned();
    let path = parts.next().unwrap_or("").to_owned();
    let (mut length, mut authorization) = (0, String::new());
    for header in reader.by_ref().lines().map(Result::unwrap) {
        if header.is_empty() {
            break;
        }
        let (name, value) = header.split_once(':').unwrap_or((&header, ""));
        if name.eq_ignore_ascii_case("content-length") {
            length = value.trim().parse().unwrap();
        } else if name.eq_ignore_ascii_case("authorization") {
            authorization = value.trim().to_owned();
        }
    }
    let mut body = vec![0; length];
    reader.read_exact(&mut body).unwrap();
    let body = serde_json::from_slice(&body).unwrap_or(Value::Null);
    Seen {
        method,
        path,
        authorization,
        body,
    }
}

/// Serves requests on a loopback port, answering each with `reply(request body)`.
fn fake_api(reply: impl Fn(&Value) -> Value + Send + 'static) -> (String, Arc<Mutex<Vec<Seen>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
    let seen = Arc::new(Mutex::new(Vec::new()));
    let log = Arc::clone(&seen);
    thread::spawn(move || {
        for stream in listener.incoming() {
            let mut stream = stream.unwrap();
            let request = read_request(&stream);
            let answer = reply(&request.body).to_string();
            log.lock().unwrap().push(request);
            write!(
                stream,
                "HTTP/1.1 201 Created\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{answer}",
                answer.len()
            )
            .unwrap();
        }
    });
    (base, seen)
}

/// A PR as GitHub would return it for `request`, at `head`.
fn echo(head: String) -> impl Fn(&Value) -> Value {
    move |request| {
        json!({
            "number": 7,
            "html_url": "https://example.invalid/pull/7",
            "head": { "sha": head, "ref": request["head"] },
            "base": { "ref": request["base"] },
            "title": request["title"],
            "body": request["body"],
            "draft": request["draft"],
        })
    }
}

struct Publish {
    fixture: Fixture,
    head: String,
    seal: String,
}

const TITLE: &str = "Add b";
const BODY: &str = "Adds b.\n";

fn prepared(name: &str) -> Publish {
    let fixture = Fixture::new(name);
    let head = fixture.commit("b.txt", "two\n", &format!("Add b\n\n{SIGNOFF}"));
    let seal = fixture.seal(TITLE, BODY);
    git(&fixture.root, &["init", "-q", "--bare", "remote.git"]);
    let work = fixture.work();
    git(
        &fixture.root.join("remote.git"),
        &[
            "fetch",
            "-q",
            work.to_str().unwrap(),
            "main:refs/heads/main",
        ],
    );
    let approval = fixture.approval(&head, TITLE, BODY);
    fs::write(fixture.root.join("approval.json"), approval.to_string()).unwrap();
    fs::write(fixture.root.join("token"), "testtoken\n").unwrap();
    Publish {
        fixture,
        head,
        seal,
    }
}

impl Publish {
    fn remote(&self) -> PathBuf {
        self.fixture.root.join("remote.git")
    }

    fn records(&self) -> PathBuf {
        self.fixture.root.join("records")
    }

    fn run(&self, api: &str, extra: &[&str]) -> Output {
        let root = &self.fixture.root;
        let tree = git(
            &self.fixture.work(),
            &["rev-parse", &format!("{}^{{tree}}", self.head)],
        );
        Command::new(env!("CARGO_BIN_EXE_reverie-publish"))
            .args([
                "new-pr",
                "--repo",
                "owner/demo",
                "--head",
                &self.head,
                "--seal",
                &self.seal,
            ])
            .args(["--tree", &tree, "--branch", "add-b", "--api-base", api])
            .args([
                "--lists-sha256",
                &reverie_publish::sha256_hex(LISTS.as_bytes()),
            ])
            .arg("--packet")
            .arg(root.join("packet"))
            .arg("--git-dir")
            .arg(root.join("store.git"))
            .arg("--lists")
            .arg(root.join("lists.json"))
            .arg("--remote-url")
            .arg(self.remote())
            .arg("--records")
            .arg(self.records())
            .arg("--token-file")
            .arg(root.join("token"))
            .args(extra)
            .output()
            .unwrap()
    }

    fn remote_branch(&self) -> Option<String> {
        let out = Command::new("git")
            .args([
                "--git-dir",
                self.remote().to_str().unwrap(),
                "rev-parse",
                "--verify",
                "-q",
                "refs/heads/add-b",
            ])
            .output()
            .unwrap();
        out.status
            .success()
            .then(|| String::from_utf8_lossy(&out.stdout).trim().to_owned())
    }

    fn with_approval(&self, approval: &Value) -> Vec<String> {
        let path = self.fixture.root.join("approval.json");
        fs::write(&path, approval.to_string()).unwrap();
        vec!["--approval".into(), path.to_string_lossy().into_owned()]
    }
}

fn approval_args(p: &Publish) -> Vec<String> {
    vec![
        "--approval".into(),
        p.fixture
            .root
            .join("approval.json")
            .to_string_lossy()
            .into_owned(),
    ]
}

fn args(v: &[String]) -> Vec<&str> {
    v.iter().map(String::as_str).collect()
}

#[test]
fn a_dry_run_checks_everything_and_writes_nothing() {
    let p = prepared("dry");
    let (api, seen) = fake_api(echo(p.head.clone()));
    let mut extra = approval_args(&p);
    extra.push("--dry".into());
    let out = p.run(&api, &args(&extra));
    assert_eq!(out.status.code(), Some(0), "{}", stderr(&out));
    let summary: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(summary["branch"], "add-b");
    assert_eq!(p.remote_branch(), None);
    assert!(!p.records().exists());
    assert!(seen.lock().unwrap().is_empty());
}

#[test]
fn publishes_the_head_to_a_new_branch_and_opens_a_draft_pr_read_back() {
    let p = prepared("publish");
    let (api, seen) = fake_api(echo(p.head.clone()));
    let out = p.run(&api, &args(&approval_args(&p)));
    assert_eq!(out.status.code(), Some(0), "{}", stderr(&out));
    assert_eq!(p.remote_branch().as_deref(), Some(p.head.as_str()));
    let requests = seen.lock().unwrap().clone();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].method, "POST");
    assert_eq!(requests[0].path, "/repos/owner/demo/pulls");
    assert_eq!(requests[0].authorization, "Bearer testtoken");
    assert_eq!(requests[0].body["draft"], true);
    assert_eq!(requests[0].body["title"], TITLE);
    assert_eq!(requests[0].body["body"], BODY);
    for record in ["INTENT.json", "PUSH-RESULT.json", "PR-READBACK.json"] {
        assert!(p.records().join(record).exists(), "{record}");
    }
    let summary: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(summary["pr"], 7);

    // The branch now exists, so a second run refuses before writing anything.
    let again = p.run(&api, &args(&approval_args(&p)));
    refused(&again, "branch add-b already exists");
    assert_eq!(seen.lock().unwrap().len(), 1);
}

#[test]
fn an_earlier_unresolved_attempt_blocks_a_retry() {
    let p = prepared("intent");
    let (api, seen) = fake_api(echo(p.head.clone()));
    fs::create_dir_all(p.records()).unwrap();
    fs::write(p.records().join("INTENT.json"), "{}").unwrap();
    refused(
        &p.run(&api, &args(&approval_args(&p))),
        "inspect the earlier attempt",
    );
    assert_eq!(p.remote_branch(), None);
    assert!(seen.lock().unwrap().is_empty());
}

#[test]
fn a_pr_that_does_not_read_back_as_published_is_reported() {
    let p = prepared("readback");
    let head = p.head.clone();
    let (api, _) = fake_api(move |request| {
        let mut pr = echo(head.clone())(request);
        pr["body"] = json!("Something else.");
        pr
    });
    refused(
        &p.run(&api, &args(&approval_args(&p))),
        "does not read back as published",
    );
    assert!(p.records().join("PR-READBACK.json").exists());
}

#[test]
fn a_write_needs_an_approval_and_refuses_a_stale_one() {
    let p = prepared("approval");
    let (api, seen) = fake_api(echo(p.head.clone()));
    assert_eq!(
        p.run(&api, &[]).status.code(),
        Some(2),
        "the approval is a required argument"
    );
    let mut stale = p
        .fixture
        .approval(&p.head, TITLE, "Adds b, as first written.\n");
    stale["reviews"] = json!(["source GO 0000aaaa"]);
    refused(
        &p.run(&api, &args(&p.with_approval(&stale))),
        "not the approved body",
    );
    assert_eq!(p.remote_branch(), None);
    assert!(seen.lock().unwrap().is_empty());
}

#[test]
fn a_stacked_base_must_be_contained_in_the_head() {
    let p = prepared("stacked");
    let work = p.fixture.work();
    git(&work, &["checkout", "-q", "-b", "other", "main"]);
    fs::write(work.join("c.txt"), "three\n").unwrap();
    git(&work, &["add", "c.txt"]);
    git(
        &work,
        &["commit", "-q", "-m", &format!("Add c\n\n{SIGNOFF}")],
    );
    git(
        &p.remote(),
        &[
            "fetch",
            "-q",
            work.to_str().unwrap(),
            "other:refs/heads/other",
        ],
    );
    let (api, _) = fake_api(echo(p.head.clone()));
    let mut extra = approval_args(&p);
    extra.extend(["--base-branch".into(), "other".into()]);
    refused(&p.run(&api, &args(&extra)), "must contain its current tip");
}

#[test]
fn an_api_base_other_than_github_or_loopback_is_refused_before_any_write() {
    let p = prepared("apibase");
    refused(
        &p.run("https://api.example.invalid", &args(&approval_args(&p))),
        "the API base must be",
    );
    assert_eq!(p.remote_branch(), None);
}
