use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Write},
    net::{TcpListener, TcpStream},
    os::unix::process::CommandExt,
    process::{Command, Output, Stdio},
    thread,
    time::{Duration, Instant},
};

fn worker(endpoint: &str, query: &str) -> Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_reverie-admin-memory"))
        .arg(format!("--hands-web-worker={}", std::process::id()))
        .env("NO_PROXY", "127.0.0.1")
        .env("no_proxy", "127.0.0.1")
        .process_group(0)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let request = json!({
        "action":"search", "query":query,
        "settings":{
            "search_url":endpoint, "search_results":1,
            "search_timeout_s":5, "search_max_bytes":4096
        }
    });
    writeln!(child.stdin.take().unwrap(), "{request}").unwrap();
    child.wait_with_output().unwrap()
}

fn serve(response: String, query: &str) -> Output {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}/searx/", listener.local_addr().unwrap());
    listener.set_nonblocking(true).unwrap();
    thread::scope(|scope| {
        let peer = scope.spawn(|| {
            let mut socket = accept(&listener);
            socket
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut line = String::new();
            BufReader::new(&socket).read_line(&mut line).unwrap();
            assert_eq!(
                line.to_ascii_lowercase().replace("%20", "+"),
                "get /searx/search?q=r%26d+%2b+caf%c3%a9+%40-+%3f&format=json http/1.1\r\n"
            );
            let _ = socket.write_all(response.as_bytes());
        });
        let output = worker(&endpoint, query);
        peer.join().unwrap();
        output
    })
}

fn accept(listener: &TcpListener) -> TcpStream {
    let started = Instant::now();
    loop {
        match listener.accept() {
            Ok((socket, _)) => return socket,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                assert!(started.elapsed() < Duration::from_secs(5));
                thread::sleep(Duration::from_millis(5));
            }
            Err(error) => panic!("{error}"),
        }
    }
}

#[test]
fn searches_a_configured_private_http_endpoint() {
    let body = r#"{"results":[{"title":"Result","url":"https://example.com","content":"Summary"},{"title":"Second"}]}"#;
    let reply = serve(
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        ),
        "R&D + café @- ?",
    );
    assert!(reply.status.success());
    assert_eq!(
        serde_json::from_slice::<Value>(&reply.stdout).unwrap(),
        json!({"text":"- Result <https://example.com>\n  Summary"})
    );
}

#[test]
fn refuses_oversized_bodies_and_non_http_redirects() {
    let body = format!("{{\"results\":[]}}{}", " ".repeat(4096));
    for response in [
        format!(
            "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n{:x}\r\n{body}\r\n0\r\n\r\n",
            body.len()
        ),
        "HTTP/1.1 302 Found\r\nLocation: file:///dev/null\r\nContent-Length: 0\r\n\r\n".into(),
    ] {
        let reply = serve(response, "R&D + café @- ?");
        assert!(!reply.status.success());
        assert!(reply.stdout.is_empty());
    }
}
