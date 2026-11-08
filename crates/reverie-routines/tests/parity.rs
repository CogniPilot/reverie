//! The native tick answers exactly as python's `reverie/routines.py` did. `routines-reference.json` was produced by the
//! unmodified python reference over `routines-cases.json`: each case lays out a policy and files, then runs commands
//! with a pinned clock against a fake console whose answers are scripted per step. It records each step's exit code,
//! stdout, stderr and every console request, then the ledgers (all rows of every table) and the reports log.

use reverie_routines::json::{self, Json};
use reverie_routines::{Env, run};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

type Routes = Arc<Mutex<HashMap<String, (u16, String)>>>;
type Log = Arc<Mutex<Vec<Json>>>;

fn fixture(name: &str) -> Json {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name);
    json::parse(&std::fs::read_to_string(path).expect("fixture")).expect("fixture json")
}

fn text(v: Option<&Json>) -> String {
    v.and_then(Json::as_str).unwrap_or_default().to_string()
}

fn list(v: Option<&Json>) -> Vec<Json> {
    match v {
        Some(Json::List(items)) => items.clone(),
        _ => Vec::new(),
    }
}

fn header<'a>(head: &'a str, name: &str) -> Option<&'a str> {
    head.split("\r\n")
        .filter_map(|l| l.split_once(':'))
        .find(|(n, _)| n.eq_ignore_ascii_case(name))
        .map(|(_, v)| v.trim())
}

/// One request: read it, record what python's fake console recorded, answer from the step's routes, close.
fn serve(mut stream: TcpStream, routes: &Routes, log: &Log) {
    let mut raw = Vec::new();
    let mut buf = [0u8; 4096];
    while !raw.windows(4).any(|w| w == b"\r\n\r\n") {
        let Ok(n) = stream.read(&mut buf) else { return };
        if n == 0 {
            return;
        }
        raw.extend_from_slice(&buf[..n]);
    }
    let end = raw.windows(4).position(|w| w == b"\r\n\r\n").unwrap_or(0);
    let head = String::from_utf8_lossy(&raw[..end]).to_string();
    let length: usize = header(&head, "content-length")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    let mut body = raw[end + 4..].to_vec();
    while body.len() < length {
        let Ok(n) = stream.read(&mut buf) else { return };
        if n == 0 {
            break;
        }
        body.extend_from_slice(&buf[..n]);
    }
    let mut first = head.split(' ');
    let (method, path) = (
        first.next().unwrap_or("").to_string(),
        first.next().unwrap_or("").to_string(),
    );
    let opt = |v: Option<&str>| v.map_or(Json::Null, |s| Json::Str(s.to_string()));
    log.lock().expect("log").push(Json::Obj(vec![
        ("method".into(), Json::Str(method.clone())),
        ("path".into(), Json::Str(path.clone())),
        (
            "token".into(),
            opt(header(&head, "x-reverie-service-token")),
        ),
        ("contentType".into(), opt(header(&head, "content-type"))),
        (
            "body".into(),
            Json::Str(String::from_utf8_lossy(&body).to_string()),
        ),
    ]));
    let (status, answer) = routes
        .lock()
        .expect("routes")
        .get(&format!("{method} {path}"))
        .cloned()
        .unwrap_or((404, String::new()));
    let reply = format!(
        "HTTP/1.0 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{answer}",
        answer.len()
    );
    let _ = stream.write_all(reply.as_bytes());
}

fn fake_console() -> (String, Routes, Log) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let url = format!(
        "http://127.0.0.1:{}",
        listener.local_addr().expect("addr").port()
    );
    let routes: Routes = Arc::default();
    let log: Log = Arc::default();
    let (r, l) = (routes.clone(), log.clone());
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            serve(stream, &r, &l);
        }
    });
    (url, routes, log)
}

fn temp_root() -> PathBuf {
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    let root = std::env::temp_dir().join(format!(
        "routines-parity-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::SeqCst)
    ));
    std::fs::create_dir_all(root.join("home")).expect("root");
    root.canonicalize().expect("canonical root")
}

/// The case's policy and files, laid out as the reference laid them out.
fn layout(case: &Json, result: &Json, root: &Path) {
    let policy = root.join("routines.json");
    let root_text = root.to_string_lossy().to_string();
    match case.get("policy_file").and_then(Json::as_str) {
        Some("directory") => std::fs::create_dir(&policy).expect("dir"),
        Some("bad-utf8") => std::fs::write(&policy, b"{\"timezone\": \"\xff\"}").expect("write"),
        _ => {}
    }
    if let Some(Json::Str(t)) = result.get("policyText") {
        std::fs::write(&policy, t.replace("<root>", &root_text)).expect("policy");
    }
    if let Some(Json::Obj(files)) = case.get("files") {
        for (name, content) in files {
            let path = root.join(name);
            std::fs::create_dir_all(path.parent().expect("parent")).expect("parent dir");
            std::fs::write(path, content.as_str().unwrap_or_default()).expect("file");
        }
    }
    if let Some(Json::Obj(links)) = case.get("symlinks") {
        for (name, target) in links {
            std::os::unix::fs::symlink(target.as_str().unwrap_or_default(), root.join(name))
                .expect("symlink");
        }
    }
}

fn env_for(case: &Json, root: &Path, url: &str) -> Env {
    let env = case.get("env");
    let token = match env.and_then(|e| e.get("token")) {
        None => Some("tok".to_string()),
        Some(Json::Str(t)) if !t.is_empty() => Some(t.clone()),
        Some(_) => None,
    };
    let console_url = env
        .and_then(|e| e.get("url"))
        .and_then(Json::as_str)
        .unwrap_or(url)
        .to_string();
    Env {
        home: root.join("home"),
        root: None,
        console_url: Some(console_url),
        token,
    }
}

/// One step: the same command line, clock and console answers as the reference step.
fn run_step(
    step: &Json,
    root: &Path,
    env: &Env,
    routes: &Routes,
    log: &Log,
) -> (i32, String, String, Vec<Json>) {
    let mut table = HashMap::new();
    if let Some(Json::Obj(items)) = step.get("routes") {
        for (key, value) in items {
            let pair = list(Some(value));
            let status = match pair.first() {
                Some(Json::Int(s)) => u16::try_from(*s).unwrap_or(500),
                _ => 500,
            };
            table.insert(key.clone(), (status, text(pair.get(1))));
        }
    }
    *routes.lock().expect("routes") = table;
    log.lock().expect("log").clear();
    let mut argv: Vec<String> = list(step.get("argv"))
        .iter()
        .map(|a| text(Some(a)))
        .collect();
    if step.get("bare").is_none() {
        let r = root.to_string_lossy();
        argv.extend([
            "--policy".into(),
            format!("{r}/routines.json"),
            "--state-dir".into(),
            format!("{r}/state"),
        ]);
    }
    let now: jiff::Timestamp = text(step.get("now")).parse().expect("now");
    let (mut out, mut err) = (Vec::new(), Vec::new());
    let code = run(&argv, env, Some(now), &mut out, &mut err);
    let mask = |b: Vec<u8>| {
        String::from_utf8(b)
            .expect("utf8")
            .replace(&*root.to_string_lossy(), "<root>")
    };
    (code, mask(out), mask(err), log.lock().expect("log").clone())
}

fn dump_ledger(path: &Path) -> Json {
    if !path.is_file() {
        return Json::Null;
    }
    let Ok(db) = rusqlite::Connection::open(path) else {
        return Json::Null;
    };
    let mut tables = Vec::new();
    for table in ["sends", "obs", "meta"] {
        let Ok(mut statement) = db.prepare(&format!("select * from {table} order by rowid")) else {
            return Json::Obj(vec![("error".into(), Json::Str("unreadable".into()))]);
        };
        let columns = statement.column_count();
        let rows: Vec<Json> = statement
            .query_map([], |row| {
                Ok(Json::List(
                    (0..columns).map(|i| cell(row.get_ref(i))).collect(),
                ))
            })
            .expect("rows")
            .map(|r| r.expect("row"))
            .collect();
        tables.push((table.to_string(), Json::Str(json::dump(&Json::List(rows)))));
    }
    Json::Obj(tables)
}

fn cell(value: rusqlite::Result<rusqlite::types::ValueRef<'_>>) -> Json {
    use rusqlite::types::ValueRef;
    match value {
        Ok(ValueRef::Integer(i)) => Json::Int(i128::from(i)),
        Ok(ValueRef::Real(f)) => Json::Float(f),
        Ok(ValueRef::Text(t)) => Json::Str(String::from_utf8_lossy(t).to_string()),
        _ => Json::Null,
    }
}

/// Every step's code, stdout, stderr and requests, then the ledgers and the reports log.
fn check_case(case: &Json, expected: &Json, failures: &mut Vec<String>) {
    let id = text(case.get("id"));
    let root = temp_root();
    layout(case, expected, &root);
    let (url, routes, log) = fake_console();
    let env = env_for(case, &root, &url);
    let code_only_case = case.get("compare_all").is_some();
    for (i, (step, want)) in list(case.get("steps"))
        .iter()
        .zip(list(expected.get("steps")))
        .enumerate()
    {
        let (code, stdout, stderr, requests) = run_step(step, &root, &env, &routes, &log);
        if want.get("code") != Some(&Json::Int(i128::from(code))) {
            failures.push(format!(
                "{id} step {i}: code {code}, python {:?}",
                want.get("code")
            ));
        }
        if code_only_case || step.get("compare").is_some() {
            continue;
        }
        for (name, got, wanted) in [
            ("stdout", stdout, text(want.get("stdout"))),
            ("stderr", stderr, text(want.get("stderr"))),
        ] {
            if got != wanted {
                failures.push(format!(
                    "{id} step {i} {name}:\n  native: {got:?}\n  python: {wanted:?}"
                ));
            }
        }
        if Json::List(requests.clone()) != *want.get("requests").unwrap_or(&Json::Null) {
            failures.push(format!(
                "{id} step {i} requests:\n  native: {}\n  python: {}",
                json::dump(&Json::List(requests)),
                json::dump(want.get("requests").unwrap_or(&Json::Null))
            ));
        }
    }
    check_files(&id, expected, &root, code_only_case, failures);
    let _ = std::fs::remove_dir_all(&root);
}

fn check_files(
    id: &str,
    expected: &Json,
    root: &Path,
    code_only: bool,
    failures: &mut Vec<String>,
) {
    if code_only {
        return;
    }
    let state = root.join("state");
    for name in ["routines.sqlite", "routines.dry.sqlite"] {
        let want = expected
            .get("ledgers")
            .and_then(|l| l.get(name))
            .cloned()
            .unwrap_or(Json::Null);
        let got = dump_ledger(&state.join(name));
        let comparable = want.get("error").is_none();
        if comparable && got != want {
            failures.push(format!(
                "{id} ledger {name}:\n  native: {}\n  python: {}",
                json::dump(&got),
                json::dump(&want)
            ));
        }
    }
    let reports = std::fs::read_to_string(state.join("routines-reports.log"))
        .ok()
        .map(|t| t.replace(&*root.to_string_lossy(), "<root>"));
    let want = expected
        .get("reports")
        .and_then(Json::as_str)
        .map(String::from);
    if reports != want {
        failures.push(format!(
            "{id} reports log:\n  native: {reports:?}\n  python: {want:?}"
        ));
    }
}

#[test]
fn every_reference_case_matches_python() {
    let cases = list(Some(&fixture("routines-cases.json")));
    let reference = fixture("routines-reference.json");
    let results = list(reference.get("results"));
    assert_eq!(cases.len(), results.len());
    assert_eq!(cases.len(), 107, "the reference covers 107 cases");
    let mut failures = Vec::new();
    for (case, expected) in cases.iter().zip(&results) {
        assert_eq!(case.get("id"), expected.get("id"));
        check_case(case, expected, &mut failures);
    }
    assert!(
        failures.is_empty(),
        "{} mismatches:\n{}",
        failures.len(),
        failures.join("\n")
    );
}
