use serde_json::{Value, json};
#[path = "support/hands.rs"]
mod hands;
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    net::{TcpListener, TcpStream},
    os::unix::fs::DirBuilderExt,
    path::{Path, PathBuf},
    process::{Command, Output},
    sync::{
        atomic::{AtomicUsize, Ordering},
        mpsc,
    },
    thread,
    time::Duration,
};

const PROGRAM: &str = env!("CARGO_BIN_EXE_reverie-backend");

struct Fixture(PathBuf);
impl Fixture {
    fn create() -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let path = std::env::temp_dir().join(format!(
            "reverie-backend-test-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::DirBuilder::new().mode(0o700).create(&path).unwrap();
        Self(path)
    }

    fn command(&self, url: &str) -> Command {
        let mut cmd = Command::new(PROGRAM);
        cmd.current_dir(&self.0)
            .env("REVERIE_API_URL", url)
            .env("REVERIE_SESSION_ID", "session-123")
            .env("REVERIE_USERNAME", "tester")
            .env("REVERIE_PASSWORD", "fixture")
            .env("NO_PROXY", "127.0.0.1")
            .env("no_proxy", "127.0.0.1")
            .env_remove("REVERIE_INSTANCE_CONFIG");
        cmd
    }

    fn run(
        &self,
        status: &str,
        response: Value,
        configure: impl FnOnce(&mut Command),
    ) -> (Output, String) {
        let (output, mut requests) =
            self.run_sequence(vec![(status.to_owned(), response)], configure);
        (output, requests.pop().unwrap())
    }

    fn run_sequence(
        &self,
        replies: Vec<(String, Value)>,
        configure: impl FnOnce(&mut Command),
    ) -> (Output, Vec<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/office///", listener.local_addr().unwrap());
        let count = replies.len();
        let (send, receive) = mpsc::channel();
        thread::spawn(move || {
            for (status, response) in replies {
                let body = response.to_string();
                let head = format!(
                    "HTTP/1.1 {status}\r\nContent-Length: {}\r\nLocation: http://127.0.0.1:1/\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let (stream, _) = listener.accept().unwrap();
                send.send(serve(stream, &head, &body)).unwrap();
            }
        });
        let mut cmd = self.command(&url);
        configure(&mut cmd);
        let output = cmd.output().unwrap();
        let requests = (0..count)
            .map(|_| {
                receive
                    .recv_timeout(Duration::from_secs(5))
                    .unwrap_or_else(|error| {
                        panic!(
                            "API exchange did not finish: {error}: {}",
                            String::from_utf8_lossy(&output.stderr)
                        )
                    })
            })
            .collect();
        (output, requests)
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

fn serve(mut stream: TcpStream, head: &str, body: &str) -> String {
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let mut reader = BufReader::new(&mut stream);
    let mut request = String::new();
    loop {
        let start = request.len();
        let length = reader.read_line(&mut request).unwrap();
        if length == 0 || &request[start..] == "\r\n" {
            break;
        }
    }
    stream.write_all(head.as_bytes()).unwrap();
    stream.write_all(body.as_bytes()).unwrap();
    request
}

fn assert_refused(output: &Output, reason: &str) {
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert!(
        String::from_utf8_lossy(&output.stderr).contains(reason),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn reads_the_envelope_and_preserves_models_for_all_harnesses() {
    for (mode, fields, argv) in [
        (
            "opencode",
            json!({"openCodeConfig":{"model":"vendor/local"}}),
            vec!["opencode", "--agent", "chat", "--model", "vendor/local"],
        ),
        (
            "codex",
            json!({"codexConfig":{"model":"vendor/local"}}),
            vec!["codex", "--model", "vendor/local"],
        ),
        (
            "claude",
            json!({"model":"vendor/local"}),
            vec!["claude", "--model", "vendor/local"],
        ),
    ] {
        let fixture = Fixture::create();
        let mut session = fields;
        session["mode"] = json!(mode);
        session["id"] = json!("session-123-unique");
        let (output, request) = fixture.run(
            "200 OK",
            json!({"success":true,"data":{"sessions":[{"id":"unrelated"},session]}}),
            |cmd| {
                cmd.args([mode, "--describe"]);
            },
        );
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            serde_json::from_slice::<Value>(&output.stdout).unwrap(),
            json!({"mode":mode,"model":"vendor/local","argv":argv})
        );
        assert!(
            request
                .lines()
                .any(|line| line == "Authorization: Basic dGVzdGVyOmZpeHR1cmU=")
        );
        let request = request.to_ascii_lowercase();
        assert!(request.starts_with("get /office/api/v1/sessions http/"));
        assert!(request.contains("x-reverie-parent-session: session-123\r\n"));
    }
}

#[test]
fn refuses_ambiguous_stale_or_incomplete_selection() {
    let fixture = Fixture::create();
    for (response, reason) in [
        (
            json!([{"id":"session-123-1"},{"id":"session-123-2"}]),
            "cannot uniquely resolve",
        ),
        (
            json!([{"id":"other","mode":"codex"}]),
            "cannot uniquely resolve",
        ),
        (
            json!([{"id":"session-123","mode":"opencode"}]),
            "does not match",
        ),
        (
            json!([{"id":"session-123","mode":"codex","codexConfig":{"model":" "}}]),
            "select a model explicitly",
        ),
        (
            json!({"success":false,"error":"private diagnostic"}),
            "rejected the session lookup",
        ),
    ] {
        let (output, _) = fixture.run("200 OK", response, |cmd| {
            cmd.args(["codex", "--describe"]);
        });
        assert_refused(&output, reason);
        assert!(!String::from_utf8_lossy(&output.stderr).contains("private diagnostic"));
    }
}

#[test]
fn rejects_bad_origins_redirects_and_header_injection() {
    let fixture = Fixture::create();
    let output = fixture
        .command("https://user:pass@127.0.0.1")
        .args(["codex", "--describe"])
        .output()
        .unwrap();
    assert_refused(&output, "without embedded credentials");
    let output = fixture
        .command("http://127.0.0.1:1")
        .env("REVERIE_SESSION_ID", "session\nAuthorization: injected")
        .args(["codex", "--describe"])
        .output()
        .unwrap();
    assert_refused(&output, "invalid Reverie session identity");
    let (output, _) = fixture.run("302 Found", json!([]), |cmd| {
        cmd.args(["codex", "--describe"]);
    });
    assert_refused(&output, "redirected to a different origin");
}

#[test]
fn follows_same_origin_redirects_and_preserves_usage_errors() {
    let fixture = Fixture::create();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let (send, receive) = mpsc::channel();
    thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        let head = "HTTP/1.1 301 Moved Permanently\r\nLocation: /office/current\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
        serve(stream, head, "");
        let (stream, _) = listener.accept().unwrap();
        let body = r#"[{"id":"session-123","mode":"opencode"}]"#;
        let head = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        send.send(serve(stream, &head, body)).unwrap();
    });
    let output = fixture
        .command(&url)
        .args(["codex", "--describe"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
    assert_refused(&output, "does not match");
    let request = receive.recv_timeout(Duration::from_secs(5)).unwrap();
    assert!(request.starts_with("GET /office/current HTTP/"));
    assert!(request.contains("X-Reverie-Parent-Session: session-123\r\n"));
    let output = fixture
        .command(&url)
        .env_remove("REVERIE_SESSION_ID")
        .args(["codex", "--describe"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
    assert_refused(&output, "API URL and session identity are required");
}

fn harness_fixture(path: &Path) {
    let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/support/harness.rs");
    let output = Command::new("rustc")
        .args(["--edition", "2024"])
        .arg(source)
        .arg("-o")
        .arg(path.join("opencode"))
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn exec_passes_literal_model_and_owner_marker_to_the_harness() {
    let fixture = Fixture::create();
    harness_fixture(&fixture.0);
    fs::write(
        fixture.0.join(".reverie-instance"),
        r#"{"instance":"./instance.json"}"#,
    )
    .unwrap();
    fs::write(
        fixture.0.join("instance.json"),
        r#"{"id":"agent-1","agent_name":"Fixture","owner_name":"Owner","persona":"Test","data_dir":"memory","role":"CTO"}"#,
    ).unwrap();
    let path = std::env::var_os("PATH").unwrap_or_default();
    let path = std::env::join_paths(
        std::iter::once(fixture.0.clone()).chain(std::env::split_paths(&path)),
    )
    .unwrap();
    let (output, _) = fixture.run(
        "200 OK",
        json!([{"id":"session-123","mode":"opencode","openCodeConfig":{"model":"vendor/model $(echo literal)"}}]),
        |cmd| { cmd.arg("opencode").env("PATH", path).env("REVERIE_INSTANCE_CONFIG", "missing.json"); },
    );
    assert_eq!(
        output.status.code(),
        Some(37),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(!fixture.0.join("memory").exists());
}
