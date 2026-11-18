use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Read, Write},
    net::{TcpListener, TcpStream},
    os::unix::process::CommandExt,
    process::{Command, Output, Stdio},
    sync::mpsc,
    thread,
    time::Duration,
};

fn worker(request: Value) -> Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_reverie-admin-memory"))
        .arg(format!("--model-completion-worker={}", std::process::id()))
        .env_clear()
        .env("Synthetic_Model_Key", "fixture-token")
        .process_group(0)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(&serde_json::to_vec(&request).unwrap())
        .unwrap();
    child.wait_with_output().unwrap()
}

fn consume_request(stream: &mut TcpStream, body: &str) {
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    let mut stream = BufReader::new(stream);
    let headers: Vec<_> = stream
        .by_ref()
        .lines()
        .map(Result::unwrap)
        .take_while(|line| !line.is_empty())
        .collect();
    assert_eq!(headers[0], "POST /v1/chat/completions HTTP/1.1");
    assert!(
        headers
            .iter()
            .any(|header| { header.eq_ignore_ascii_case("authorization: bearer fixture-token") })
    );
    let mut input = vec![0; body.len()];
    stream.read_exact(&mut input).unwrap();
    assert_eq!(input, body.as_bytes());
}

fn model_request(response: &str) -> Output {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!(
        "http://{}/v1/chat/completions",
        listener.local_addr().unwrap()
    );
    let body = r#"{"model":"fixture","messages":[{"content":"\ud800\udc00"}],"max_tokens":64}"#;
    let response = response.to_owned();
    let (finished, settled) = mpsc::channel();
    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        consume_request(&mut stream, body);
        stream.write_all(response.as_bytes()).unwrap();
        finished.send(()).unwrap();
    });
    let output = worker(json!({
        "action": "complete", "url": url, "body": body,
        "timeout": 2.5, "key_env": "Synthetic_Model_Key",
    }));
    settled.recv_timeout(Duration::from_secs(3)).unwrap();
    server.join().unwrap();
    output
}

#[test]
fn worker_preserves_request_bytes_and_returns_raw_usage_for_accounting() {
    let reply = r#"{"choices":[{"message":{"content":"Hello"}}],"usage":{"total_tokens":42}}"#;
    let output = model_request(&format!(
        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}",
        reply.len()
    ));
    assert!(output.status.success());
    assert_eq!(output.stdout, reply.as_bytes());
}

#[test]
fn worker_refuses_redirects_and_returns_no_partial_response() {
    let output = model_request(
        "HTTP/1.1 302 Found\r\nLocation: /other\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
    );
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
}

fn formatted(action: &str, points: Vec<u32>, limit: i64) -> Vec<u32> {
    let output = worker(json!({"action": action, "points": points, "limit": limit}));
    assert!(output.status.success());
    let reply: Value = serde_json::from_slice(&output.stdout).unwrap();
    serde_json::from_value(reply["points"].clone()).unwrap()
}

fn codepoints(text: &str) -> Vec<u32> {
    text.chars().map(u32::from).collect()
}

#[test]
fn formatting_honors_legacy_whitespace_casing_punctuation_and_codepoints() {
    let mut text = codepoints(" \t<think>discard\nthis</think>**One!**\x1c");
    text.extend([0xd801, 0xdc00]);
    text.extend(codepoints("  end"));
    let mut expected = codepoints("One! ");
    expected.push(0xd801);
    assert_eq!(formatted("clean", text, 6), expected);
    let text = codepoints("so true!\" she said and then more words here");
    assert_eq!(formatted("limit_words", text, 3), codepoints("so true!\""));
    assert_eq!(
        formatted("clean", codepoints("<THINK>*one*</THINK> <think> two"), -1),
        codepoints("<THINK>one</THINK> <think> tw")
    );
}
