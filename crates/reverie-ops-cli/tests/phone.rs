//! Actual native CLI and owned TCP HTTP transport. Server receipts remain data;
//! these fixtures supply no host authority or real OPS effect implementation.
use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    process::{Command, Stdio},
    sync::mpsc,
    time::{Duration, Instant},
};
const REFUSAL: &[u8] = b"{\"reason\":\"adapter-unavailable\",\"success\":false}\n";
struct Request {
    head: String,
    body: Vec<u8>,
}
fn accept(listener: &TcpListener) -> TcpStream {
    listener.set_nonblocking(true).unwrap();
    let until = Instant::now() + Duration::from_secs(4);
    loop {
        match listener.accept() {
            Ok((stream, _)) => {
                stream.set_nonblocking(false).unwrap();
                return stream;
            }
            Err(error)
                if error.kind() == std::io::ErrorKind::WouldBlock && Instant::now() < until =>
            {
                std::thread::sleep(Duration::from_millis(1));
            }
            Err(error) => panic!("owned test listener did not receive a request: {error}"),
        }
    }
}
fn receive(stream: &mut TcpStream) -> Request {
    stream
        .set_read_timeout(Some(Duration::from_secs(4)))
        .unwrap();
    stream
        .set_write_timeout(Some(Duration::from_secs(4)))
        .unwrap();
    let mut head = Vec::new();
    while !head.ends_with(b"\r\n\r\n") {
        let mut byte = [0];
        stream.read_exact(&mut byte).unwrap();
        head.push(byte[0]);
        assert!(head.len() < 65536);
    }
    let head = String::from_utf8(head).unwrap();
    let length = head
        .lines()
        .find_map(|line| {
            let (key, value) = line.split_once(':')?;
            key.eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse::<usize>().unwrap())
        })
        .unwrap();
    assert!(length <= 16384);
    let mut body = vec![0; length];
    stream.read_exact(&mut body).unwrap();
    Request { head, body }
}
fn command() -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_reverie-ops"));
    command.env_clear();
    // Windows socket providers expand this variable when loading their DLLs.
    // Preserve only the OS requirement, not caller credentials or proxy state.
    #[cfg(windows)]
    command.env(
        "SystemRoot",
        std::env::var_os("SystemRoot").expect("Windows socket tests require SystemRoot"),
    );
    command
}
fn cli(url: &str, args: &[&str], input: &[u8]) -> std::process::Output {
    let mut child = command()
        .args(args)
        .env("REVERIE_API_URL", url)
        .env("http_proxy", "http://127.0.0.1:1")
        .env("REVERIE_SESSION_ID", "caller-does-not-select-actor")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(input).unwrap();
    child.wait_with_output().unwrap()
}
fn roundtrip(args: &[&str], input: &[u8], response: Vec<u8>) -> (std::process::Output, Request) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let (sent, received) = mpsc::channel();
    let worker = std::thread::spawn(move || {
        let mut stream = accept(&listener);
        let request = receive(&mut stream);
        // Error cases deliberately close before all supplied response bytes.
        let _ = stream.write_all(&response);
        drop(stream);
        sent.send(request).unwrap();
        listener.set_nonblocking(true).unwrap();
        assert!(
            matches!(listener.accept(),Err(error)if error.kind()==std::io::ErrorKind::WouldBlock)
        );
    });
    let output = cli(&format!("http://{address}"), args, input);
    let request = received
        .recv_timeout(Duration::from_secs(10))
        .unwrap_or_else(|error| {
            panic!(
                "owned phone request missing ({error}); CLI status={}, stdout={:?}, stderr={:?}",
                output.status,
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            )
        });
    worker.join().unwrap();
    (output, request)
}
fn reply(status: &str, body: &[u8]) -> Vec<u8> {
    let mut response = format!(
        "HTTP/1.1 {status}\r\nContent-Length: {}\r\n\r\n",
        body.len()
    )
    .into_bytes();
    response.extend_from_slice(body);
    response
}
fn effect() -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({
        "kind":"reverie.ops.command","version":1,"requestId":"req-explicit","resourceId":"website",
        "action":"reverie.ops.website.restart","idempotencyKey":"idem-explicit",
        "grantRef":{"grantId":"grant-explicit","policyGeneration":format!("sha256:{}","a".repeat(64))},
        "artifact":{"artifactId":"artifact-explicit","digest":format!("sha256:{}","b".repeat(64)),"reviewId":"review-explicit"},
        "expectedResourceGeneration":format!("sha256:{}","c".repeat(64)),
        "expectedCapabilityGeneration":format!("sha256:{}","d".repeat(64)),
    })).unwrap()
}
#[test]
fn status_and_inspect_use_only_the_fixed_phone_path_and_exact_checked_fields() {
    for args in [
        vec!["status", "website"],
        vec!["inspect", "website", "operation-1"],
    ] {
        let (output, request) = roundtrip(
            &args,
            b"",
            reply("200 OK", br#"{"success":true,"view":{"available":true}}"#),
        );
        assert_eq!(output.status.code(), Some(0));
        assert_eq!(
            output.stdout,
            b"{\"success\":true,\"view\":{\"available\":true}}\n"
        );
        assert!(request.head.starts_with("POST /api/ops HTTP/1.1\r\n"));
        assert!(!request.head.to_ascii_lowercase().contains("authorization"));
        assert!(!request.head.contains("caller-does-not-select-actor"));
        let data: serde_json::Value = serde_json::from_slice(&request.body).unwrap();
        assert_eq!(data["resourceId"], "website");
        assert_eq!(data["version"], 1);
        let request_id = data["requestId"].as_str().unwrap();
        assert!(request_id.starts_with("req-"));
        assert_eq!(request_id.len(), 36);
        assert_eq!(request_id.as_bytes()[16], b'4');
        if args[0] == "inspect" {
            assert_eq!(data["operationId"], "operation-1");
        } else {
            assert_eq!(data["action"], "reverie.ops.status");
        }
    }
}
#[test]
fn submit_preserves_the_exact_explicit_grant_artifact_generations_and_idempotency() {
    let command = effect();
    let (output, request) = roundtrip(
        &["submit"],
        &command,
        reply(
            "202 Accepted",
            br#"{"success":true,"operationId":"existing-operation"}"#,
        ),
    );
    assert_eq!(output.status.code(), Some(0));
    let expected = reverie_contracts::ops_command::OpsCommand::decode(&command).unwrap();
    assert_eq!(request.body, expected.canonical_bytes());
}
#[test]
fn invalid_or_oversized_submit_never_connects_or_infers_identity() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let mut with_actor: serde_json::Value = serde_json::from_slice(&effect()).unwrap();
    with_actor["actor"] = serde_json::json!({"owner":true});
    for body in [
        b"{}".to_vec(),
        b"[]".to_vec(),
        vec![b' '; 16385],
        serde_json::to_vec(&with_actor).unwrap(),
    ] {
        let output = cli(&url, &["submit"], &body);
        assert_eq!(output.status.code(), Some(3));
        assert_eq!(output.stdout, REFUSAL);
        assert!(
            matches!(listener.accept(),Err(error)if error.kind()==std::io::ErrorKind::WouldBlock)
        );
    }
}
#[test]
fn reply_body_controls_exit_and_canonical_output_without_http_status_or_redirect_shortcuts() {
    for (body, code) in [
        (
            br#"{"success":false,"reason":"revoked-grant"}"#.as_slice(),
            3,
        ),
        (br#"{"success":"false","data":"\u00e9"}"#.as_slice(), 0),
    ] {
        let (output, _) = roundtrip(&["status", "website"], b"", reply("503 Unavailable", body));
        assert_eq!(output.status.code(), Some(code));
        let parsed = reverie_contracts::ops_command::OpsReply::decode(body).unwrap();
        assert_eq!(output.stdout, [parsed.canonical_bytes(), b"\n"].concat());
    }
    let (output, _) = roundtrip(
        &["submit"],
        &effect(),
        b"HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/\r\nContent-Length: 0\r\n\r\n"
            .to_vec(),
    );
    assert_eq!(output.status.code(), Some(3));
    assert_eq!(output.stdout, REFUSAL);
}
#[test]
fn malformed_duplicate_overflow_or_lost_replies_are_negative_and_never_replayed() {
    let invalid = [
        br#"{"success":true,"success":false}"#.to_vec(),
        b"[]".to_vec(),
        br#"{"success":true,"number":1e999}"#.to_vec(),
        vec![b' '; 65537],
    ];
    for body in invalid {
        let (output, _) = roundtrip(&["submit"], &effect(), reply("200 OK", &body));
        assert_eq!(output.status.code(), Some(3));
        assert_eq!(output.stdout, REFUSAL);
    }
    let (output, _) = roundtrip(&["submit"], &effect(), Vec::new());
    assert_eq!(output.status.code(), Some(3));
    assert_eq!(output.stdout, REFUSAL);
}
#[test]
fn ordinary_chunked_continue_and_unexpected_informational_heads_are_checked() {
    let body = br#"{"success":true}"#;
    let response = format!("HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n{:x}\r\n{}\r\n0\r\n\r\n",body.len(),std::str::from_utf8(body).unwrap()).into_bytes();
    let (output, _) = roundtrip(&["status", "website"], b"", response);
    assert_eq!(output.status.code(), Some(0));
    let mut response = b"HTTP/1.1 103 Early Hints\r\n\r\n".to_vec();
    response.extend(reply("200 OK", body));
    let (output, _) = roundtrip(&["submit"], &effect(), response);
    assert_eq!(output.status.code(), Some(3));
    assert_eq!(output.stdout, REFUSAL);
}
#[test]
fn overlong_decimal_port_is_refused_before_any_tcp_connection() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let port = listener.local_addr().unwrap().port().to_string();
    for digits in [4301, 5001] {
        let url = format!("http://127.0.0.1:{}{port}", "0".repeat(digits - port.len()));
        let output = cli(&url, &["status", "website"], b"");
        assert_eq!(output.status.code(), Some(3));
        assert_eq!(output.stdout, REFUSAL);
        assert!(
            matches!(listener.accept(), Err(error) if error.kind()==std::io::ErrorKind::WouldBlock)
        );
    }
}
#[test]
fn help_is_available_without_installation_and_names_permissions_output_and_recovery() {
    let output = command().arg("--help").output().unwrap();
    assert!(output.status.success());
    let text = String::from_utf8(output.stdout).unwrap();
    for word in [
        "status",
        "inspect",
        "submit",
        "grant",
        "REVERIE_API_URL",
        "Exit 0",
        "never retries",
    ] {
        assert!(text.contains(word), "{word}");
    }
    let output = command().args(["status", "website"]).output().unwrap();
    assert_eq!(output.status.code(), Some(3));
    assert_eq!(output.stdout, REFUSAL);
}
