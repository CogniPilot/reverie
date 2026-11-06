use super::*;
use reverie_contracts::memory::encode_embedding_request;
use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    sync::mpsc,
    thread,
};
struct Observed {
    first: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}
impl Observed {
    fn header(&self, key: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(name, _)| name.eq_ignore_ascii_case(key))
            .map(|(_, value)| value.as_str())
    }
}
struct Server {
    url: String,
    observed: mpsc::Receiver<Observed>,
    thread: Option<thread::JoinHandle<()>>,
}
fn observed(socket: &mut TcpStream) -> Observed {
    socket
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    let mut raw = Vec::new();
    let mut byte = [0];
    while !raw.ends_with(b"\r\n\r\n") {
        assert_eq!(socket.read(&mut byte).unwrap(), 1);
        raw.push(byte[0]);
        assert!(raw.len() < 65536);
    }
    let header = raw.iter().map(|&byte| char::from(byte)).collect::<String>();
    let mut lines = header.split("\r\n");
    let first = lines.next().unwrap().to_owned();
    let headers: Vec<(String, String)> = lines
        .filter_map(|line| {
            line.split_once(':')
                .map(|(name, value)| (name.into(), value.trim().into()))
        })
        .collect();
    let length = headers
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case("content-length"))
        .map_or(0, |(_, value): &(String, String)| value.parse().unwrap());
    let mut body = vec![0; length];
    socket.read_exact(&mut body).unwrap();
    Observed {
        first,
        headers,
        body,
    }
}
fn response(status: &str, headers: &str, body: &[u8]) -> Vec<u8> {
    let mut raw = format!(
        "HTTP/1.1 {status}\r\nConnection: close\r\nContent-Length: {}\r\n{headers}\r\n",
        body.len()
    )
    .into_bytes();
    raw.extend(body);
    raw
}
impl Server {
    fn new(replies: Vec<Vec<u8>>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let (sender, observed) = mpsc::channel();
        let thread = thread::spawn(move || {
            for reply in replies {
                let mut socket = accept(&listener);
                sender.send(self::observed(&mut socket)).unwrap();
                socket.write_all(&reply).unwrap();
            }
        });
        Self {
            url,
            observed,
            thread: Some(thread),
        }
    }
    fn next(&self) -> Observed {
        self.observed.recv_timeout(Duration::from_secs(5)).unwrap()
    }
}
fn accept(listener: &TcpListener) -> TcpStream {
    let start = std::time::Instant::now();
    loop {
        match listener.accept() {
            Ok((socket, _)) => return socket,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                assert!(
                    start.elapsed() < Duration::from_secs(5),
                    "test server expected another request"
                );
                thread::sleep(Duration::from_millis(1));
            }
            Err(error) => panic!("{error}"),
        }
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        if let Some(thread) = self.thread.take() {
            thread.join().unwrap();
        }
    }
}
fn embedder(url: String) -> LlamaEmbedder {
    let mut embedder = LlamaEmbedder::new(LlamaConfig::new(url, "model"));
    embedder.proxies = ProxySettings::default();
    embedder
}
#[test]
fn raw_dot_paths_json_body_prefixes_and_dimensions() {
    let server = Server::new(vec![
        response("200 OK", "", br#"{"data":[{"embedding":[3,4]}]}"#),
        response("200 OK", "", br#"{"data":[{"embedding":["bad",4,5]}]}"#),
    ]);
    let embedder = embedder(format!("{}/a/../%2e/%2E%2e/v1/", server.url));
    assert_eq!(
        embedder
            .request_embedding("𝄞\n\"", EmbeddingKind::Query)
            .unwrap(),
        [0.6, 0.8]
    );
    assert_eq!(embedder.dimensions(), 2);
    let first = server.next();
    assert_eq!(first.first, "POST /a/../%2e/%2E%2e/v1/embeddings HTTP/1.1");
    assert_eq!(
        first.body,
        encode_embedding_request("search_query: 𝄞\n\"", "model")
    );
    assert_eq!(first.header("content-type"), Some("application/json"));
    assert_eq!(first.header("accept-encoding"), Some("identity"));
    assert!(
        embedder
            .request_embedding("text", EmbeddingKind::Document)
            .is_err()
    );
    assert_eq!(embedder.dimensions(), 3);
    assert_eq!(
        server.next().body,
        encode_embedding_request("search_document: text", "model")
    );
}
#[test]
fn discarded_surrogate_url_fragments_remain_accepted_but_network_text_refuses() {
    for prefix in ["", " \u{2003}URL: "] {
        let server = Server::new(vec![response(
            "200 OK",
            "",
            br#"{"data":[{"embedding":[3,4]}]}"#,
        )]);
        let mut raw = format!("{prefix}{}/route#", server.url)
            .chars()
            .map(u32::from)
            .collect::<Vec<_>>();
        raw.push(0xd800);
        let config = LlamaConfig::from_text(
            embedding_text(EmbeddingText::from_codepoints(&raw).unwrap()),
            MetadataText::from_scalar_text("model"),
        );
        let mut model = LlamaEmbedder::new(config);
        model.proxies = ProxySettings::default();
        assert_eq!(
            model
                .request_embedding("text", EmbeddingKind::Document)
                .unwrap(),
            [0.6, 0.8]
        );
        assert_eq!(server.next().first, "POST /route HTTP/1.1");
    }
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    for raw in [
        format!("http://HOST{}/route", listener.local_addr().unwrap()),
        format!("http://{}/PATH", listener.local_addr().unwrap()),
    ] {
        let raw = raw
            .replace("HOST", "\u{e000}")
            .replace("PATH", "\u{e000}")
            .chars()
            .map(|c| {
                if c == '\u{e000}' {
                    0xd800
                } else {
                    u32::from(c)
                }
            })
            .collect::<Vec<_>>();
        let config = LlamaConfig::from_text(
            embedding_text(EmbeddingText::from_codepoints(&raw).unwrap()),
            MetadataText::from_scalar_text("model"),
        );
        let mut model = LlamaEmbedder::new(config);
        model.proxies = ProxySettings::default();
        assert!(matches!(
            model.request_embedding("text", EmbeddingKind::Document),
            Err(LlamaError::InvalidEndpoint)
        ));
        assert_eq!(
            listener.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
    }
}
#[test]
fn informational_heads_preserve_source_continue_and_tunnel_status_rules() {
    let final_reply = response("200 OK", "", br#"{"data":[{"embedding":[3,4]}]}"#);
    for (status, accepted) in [(100, true), (102, false), (103, false)] {
        let mut reply = format!("HTTP/1.1 {status} Informational\r\n\r\n").into_bytes();
        reply.extend_from_slice(&final_reply);
        let server = Server::new(vec![reply]);
        let result =
            embedder(server.url.clone()).request_embedding("text", EmbeddingKind::Document);
        if accepted {
            assert_eq!(result.unwrap(), [0.6, 0.8]);
        } else {
            assert!(
                matches!(result,Err(LlamaError::HttpStatus(code)) if code==status),
                "{result:?}"
            );
        }
        server.next();
    }
    for status in [100, 201] {
        let server = Server::new(vec![response(&format!("{status} Not a tunnel"), "", b"")]);
        let mut embedder = embedder("https://synthetic.invalid".into());
        embedder.proxies =
            ProxySettings::from_pairs(vec![("https_proxy".into(), server.url.clone().into())]);
        let result = embedder.request_embedding("text", EmbeddingKind::Document);
        assert!(
            matches!(result,Err(LlamaError::HttpStatus(code)) if code==status),
            "{result:?}"
        );
        assert!(server.next().first.starts_with("CONNECT "));
    }
}
#[test]
fn accepted_large_response_heads_do_not_inherit_a_smaller_aggregate_limit() {
    // http.client permits 99 fields plus the closing blank line. Two fields
    // come from response(); 97 additional fields remain accepted.
    for extra in [97, 98] {
        let headers = (0..extra)
            .map(|n| format!("X-{n}: {}\r\n", "a".repeat(4096)))
            .collect::<String>();
        let server = Server::new(vec![response(
            "200 OK",
            &headers,
            br#"{"data":[{"embedding":[3,4]}]}"#,
        )]);
        let result =
            embedder(server.url.clone()).request_embedding("text", EmbeddingKind::Document);
        assert_eq!(result.is_ok(), extra == 97, "{result:?}");
        server.next();
    }
}
#[test]
fn post_redirect_becomes_get_preserves_absolute_path_and_drops_content_headers() {
    let server = Server::new(vec![
        response("302 Found", "Location: /final\r\n", b"drained"),
        response("200 OK", "", br#"{"data":[{"embedding":[3,4]}]}"#),
    ]);
    let embedder = embedder(server.url.clone());
    assert_eq!(
        embedder
            .request_embedding("text", EmbeddingKind::Document)
            .unwrap(),
        [0.6, 0.8]
    );
    assert!(server.next().first.starts_with("POST "));
    let next = server.next();
    assert_eq!(next.first, "GET /final HTTP/1.1");
    assert!(next.body.is_empty());
    assert_eq!(next.header("content-type"), None);
    assert_eq!(next.header("content-length"), None);
}
#[test]
fn refused_307_and_lost_reply_never_replay_post() {
    for reply in [
        response(
            "307 Temporary Redirect",
            "Location: /again\r\n",
            br#"{"data":[{"embedding":[3,4]}]}"#,
        ),
        Vec::new(),
    ] {
        let server = Server::new(vec![reply]);
        let embedder = embedder(server.url.clone());
        assert!(
            embedder
                .request_embedding("text", EmbeddingKind::Document)
                .is_err()
        );
        assert!(server.next().first.starts_with("POST "));
    }
}
#[test]
fn explicit_http_forward_proxy_and_cgi_environment_precedence() {
    let server = Server::new(vec![response(
        "200 OK",
        "",
        br#"{"data":[{"embedding":[3,4]}]}"#,
    )]);
    let mut embedder = embedder("http://synthetic.invalid/a/../b".into());
    embedder.proxies = ProxySettings::from_pairs(vec![(
        "http_proxy".into(),
        server.url.replace("://", "://user:p%61ss@").into(),
    )]);
    assert!(
        embedder
            .request_embedding("text", EmbeddingKind::Document)
            .is_ok()
    );
    let request = server.next();
    assert_eq!(
        request.first,
        "POST http://synthetic.invalid/a/../b/embeddings HTTP/1.1"
    );
    assert_eq!(
        request.header("proxy-authorization"),
        Some("Basic dXNlcjpwYXNz")
    );
    let target = policy::Origin::parse("http://example.invalid/path").unwrap();
    let selected = ProxySettings::from_pairs(vec![
        ("HTTP_PROXY".into(), "http://upper:123".into()),
        ("REQUEST_METHOD".into(), "GET".into()),
    ]);
    assert!(selected.selected(&target.network).unwrap().is_none());
    let selected = ProxySettings::from_pairs(vec![
        ("HTTP_PROXY".into(), "http://upper:123".into()),
        ("http_proxy".into(), "http://lower:456".into()),
        ("REQUEST_METHOD".into(), "GET".into()),
    ]);
    assert_eq!(
        selected.selected(&target.network).unwrap().unwrap().host,
        "lower"
    );
}
#[test]
fn source_redirect_join_preserves_unescaped_absolute_and_encoded_dot_segments() {
    use super::redirect::redirect_url;
    let base = "http://h/a/../%2e/b/embeddings?old=1";
    for (location, expected) in [
        ("?q=1", "http://h/a/../%2e/b/embeddings?q=1"),
        ("#f", "http://h/a/../%2e/b/embeddings?old=1#f"),
        ("http://h/a/../z", "http://h/a/../z"),
        ("//h/a/../z", "http://h/a/../z"),
        ("../%2e/%2e%2e/z", "http://h/%2e/%2e/%2e%2e/z"),
        ("/a/../z", "http://h/z"),
    ] {
        assert_eq!(redirect_url(base, location.as_bytes()).unwrap(), expected);
    }
}
#[test]
fn response_over_ten_mebibytes_has_no_new_cap() {
    let mut body = br#"{"data":[{"embedding":[3,4]}]}"#.to_vec();
    body.resize(11 * 1024 * 1024, b' ');
    let server = Server::new(vec![response("200 OK", "", &body)]);
    let embedder = embedder(server.url.clone());
    assert_eq!(
        embedder
            .request_embedding("text", EmbeddingKind::Document)
            .unwrap(),
        [0.6, 0.8]
    );
    server.next();
}
#[test]
fn chunked_reads_reset_inactivity_timer_and_may_exceed_total_timeout() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let thread = thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        let request = observed(&mut socket);
        socket
            .write_all(
                b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n",
            )
            .unwrap();
        for chunk in [
            b"{\"data\":".as_slice(),
            b"[{\"embedding\":",
            b"[3,4]",
            b"}]}",
        ] {
            thread::sleep(Duration::from_millis(70));
            write!(socket, "{:x}\r\n", chunk.len()).unwrap();
            socket.write_all(chunk).unwrap();
            socket.write_all(b"\r\n").unwrap();
        }
        socket.write_all(b"0\r\n\r\n").unwrap();
        request
    });
    let mut embedder = embedder(url);
    embedder.config.timeout = Duration::from_millis(180);
    let started = std::time::Instant::now();
    assert_eq!(
        embedder
            .request_embedding("text", EmbeddingKind::Document)
            .unwrap(),
        [0.6, 0.8]
    );
    assert!(started.elapsed() > embedder.config.timeout);
    assert!(thread.join().unwrap().first.starts_with("POST "));
}
#[test]
fn inactivity_times_out_but_http_failure_does_not_drain_stalled_body() {
    for status in ["200 OK", "500 Failed"] {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let thread = thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            observed(&mut socket);
            write!(
                socket,
                "HTTP/1.1 {status}\r\nContent-Length: 1000000\r\nConnection: close\r\n\r\n"
            )
            .unwrap();
            thread::sleep(Duration::from_millis(350));
        });
        let mut embedder = embedder(url);
        embedder.config.timeout = Duration::from_millis(150);
        let started = std::time::Instant::now();
        let result = embedder.request_embedding("text", EmbeddingKind::Document);
        assert!(result.is_err());
        if status.starts_with("500") {
            assert!(matches!(result, Err(LlamaError::HttpStatus(500))));
            assert!(started.elapsed() < Duration::from_millis(130));
        } else {
            assert!(started.elapsed() >= Duration::from_millis(150));
        }
        thread.join().unwrap();
    }
}
#[test]
fn redirect_repeat_count_matches_urllib_five_requests_and_does_not_replay_post() {
    let server = Server::new(vec![response("302 Found", "Location: /again\r\n", b""); 5]);
    let embedder = embedder(server.url.clone());
    assert!(matches!(
        embedder.request_embedding("text", EmbeddingKind::Document),
        Err(LlamaError::Redirect)
    ));
    assert!(server.next().first.starts_with("POST "));
    for _ in 0..4 {
        assert_eq!(server.next().first, "GET /again HTTP/1.1");
    }
}
#[test]
fn startup_probe_fallback_is_single_and_later_failures_do_not_switch_model() {
    let selection = make_embedder(
        Some(LlamaConfig::new("unsupported://synthetic", "configured")),
        64,
    );
    assert_eq!(selection.fallback, Some(EmbeddingFallback::ProbeFailed));
    assert_eq!(selection.embedder.name(), "hashed-v1-64");
    let server = Server::new(vec![
        response("200 OK", "", br#"{"data":[{"embedding":[3,4]}]}"#),
        response("500 Failed", "", b"no model"),
    ]);
    let mut model = embedder(server.url.clone());
    model.config.model = MetadataText::from_scalar_text("");
    assert!(
        model
            .request_embedding("probe", EmbeddingKind::Document)
            .is_ok()
    );
    let selected = EmbeddingSelection {
        embedder: Arc::new(model),
        fallback: None,
    };
    assert!(
        selected
            .embedder
            .embed("later", EmbeddingKind::Query)
            .is_err()
    );
    assert_eq!(selected.embedder.name(), "llama:model");
    assert_eq!(selected.embedder.dimensions(), 2);
    assert_eq!(
        server.next().body,
        encode_embedding_request("search_document: probe", "")
    );
    assert_eq!(
        server.next().body,
        encode_embedding_request("search_query: later", "")
    );
}
#[test]
fn proxy_credentials_are_not_carried_to_bypassed_redirect_origin() {
    let origin = Server::new(vec![response(
        "200 OK",
        "",
        br#"{"data":[{"embedding":[3,4]}]}"#,
    )]);
    let proxy = Server::new(vec![response(
        "302 Found",
        &format!("Location: {}/final\r\n", origin.url),
        b"",
    )]);
    let mut embedder = embedder("http://synthetic.invalid".into());
    embedder.proxies = ProxySettings::from_pairs(vec![
        (
            "http_proxy".into(),
            proxy.url.replace("://", "://synthetic:password@").into(),
        ),
        ("no_proxy".into(), "127.0.0.1".into()),
    ]);
    assert!(
        embedder
            .request_embedding("text", EmbeddingKind::Document)
            .is_ok()
    );
    assert_eq!(
        proxy.next().header("proxy-authorization"),
        Some("Basic c3ludGhldGljOnBhc3N3b3Jk")
    );
    assert_eq!(origin.next().header("proxy-authorization"), None);
}
#[test]
fn redirected_new_proxy_uses_its_own_credentials() {
    let second = Server::new(vec![response("502 Refused", "", b"")]);
    let first = Server::new(vec![response(
        "302 Found",
        "Location: https://synthetic-second.invalid/final\r\n",
        b"",
    )]);
    let mut embedder = embedder("http://synthetic-first.invalid".into());
    embedder.proxies = ProxySettings::from_pairs(vec![
        (
            "http_proxy".into(),
            first.url.replace("://", "://first:password@").into(),
        ),
        (
            "https_proxy".into(),
            second.url.replace("://", "://second:password@").into(),
        ),
    ]);
    assert!(matches!(
        embedder.request_embedding("text", EmbeddingKind::Document),
        Err(LlamaError::HttpStatus(502))
    ));
    assert_eq!(
        first.next().header("proxy-authorization"),
        Some("Basic Zmlyc3Q6cGFzc3dvcmQ=")
    );
    let second = second.next();
    assert_eq!(
        second.first,
        "CONNECT synthetic-second.invalid:443 HTTP/1.1"
    );
    assert_eq!(
        second.header("proxy-authorization"),
        Some("Basic c2Vjb25kOnBhc3N3b3Jk")
    );
}
#[test]
fn slow_request_upload_does_not_spend_later_response_read_budget() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let server = thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(4)))
            .unwrap();
        socket2::SockRef::from(&socket)
            .set_recv_buffer_size(65536)
            .unwrap();
        let mut raw = Vec::new();
        let mut byte = [0];
        while !raw.ends_with(b"\r\n\r\n") {
            socket.read_exact(&mut byte).unwrap();
            raw.push(byte[0]);
        }
        let text = std::str::from_utf8(&raw).unwrap();
        let length: usize = text
            .lines()
            .filter_map(|line| line.split_once(':'))
            .find(|(key, _)| key.eq_ignore_ascii_case("content-length"))
            .unwrap()
            .1
            .trim()
            .parse()
            .unwrap();
        thread::sleep(Duration::from_millis(650));
        let mut left = length;
        let mut buffer = [0; 65536];
        while left > 0 {
            let count = socket.read(&mut buffer[..left.min(65536)]).unwrap();
            assert!(count > 0);
            left -= count;
        }
        thread::sleep(Duration::from_millis(650));
        let body = br#"{"data":[{"embedding":[3,4]}]}"#;
        socket.write_all(&response("200 OK", "", body)).unwrap();
    });
    let mut embedder = embedder(url);
    embedder.config.timeout = Duration::from_secs(1);
    let text = "x".repeat(8 * 1024 * 1024);
    let started = std::time::Instant::now();
    assert_eq!(
        embedder
            .request_embedding(&text, EmbeddingKind::Document)
            .unwrap(),
        [0.6, 0.8]
    );
    assert!(started.elapsed() > embedder.config.timeout);
    server.join().unwrap();
}
#[test]
fn request_sendall_budget_is_not_renewed_by_partial_write_progress() {
    use std::sync::atomic::{AtomicBool, Ordering};
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let stop = Arc::new(AtomicBool::new(false));
    let server_stop = Arc::clone(&stop);
    let server = thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        socket2::SockRef::from(&socket)
            .set_recv_buffer_size(65536)
            .unwrap();
        let mut total = 0;
        let mut buffer = [0; 65536];
        while !server_stop.load(Ordering::Acquire) {
            let count = socket.read(&mut buffer).unwrap();
            if count == 0 {
                break;
            }
            total += count;
            thread::sleep(Duration::from_millis(40));
        }
        total
    });
    let mut embedder = embedder(url);
    embedder.config.timeout = Duration::from_millis(300);
    let text = "x".repeat(16 * 1024 * 1024);
    let started = std::time::Instant::now();
    let result = embedder.request_embedding(&text, EmbeddingKind::Document);
    stop.store(true, Ordering::Release);
    assert!(result.is_err());
    assert!(started.elapsed() < Duration::from_secs(3));
    let sent = server.join().unwrap();
    assert!(sent > 0 && sent < text.len());
}
#[test]
fn actual_python_lone_surrogate_query_model_body_and_name_vectors_remain_lossless() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../tests/fixtures/memory-codepoint-embeddings-python.json"
    ))
    .unwrap();
    for case in fixture["hashed"].as_array().unwrap() {
        let codepoints = points(&case["textCodepoints"]);
        let vector = HashedEmbedder::new(64)
            .embed_text(
                EmbeddingText::from_codepoints(&codepoints).unwrap(),
                EmbeddingKind::Query,
            )
            .unwrap();
        assert_eq!(
            vector
                .iter()
                .map(|value| value.to_bits())
                .collect::<Vec<_>>(),
            case["bits"]
                .as_array()
                .unwrap()
                .iter()
                .map(|value| value.as_u64().unwrap())
                .collect::<Vec<_>>()
        );
        let actual = reverie_core::memory::pack(&vector)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        assert_eq!(actual, case["packedHex"].as_str().unwrap());
    }
    let cases = fixture["http"].as_array().unwrap();
    let server = Server::new(vec![
        response(
            "200 OK",
            "",
            br#"{"data":[{"embedding":[3,4]}]}"#
        );
        cases.len()
    ]);
    for case in cases {
        let model = points(&case["modelCodepoints"]);
        let input = points(&case["textCodepoints"]);
        let mut config = LlamaConfig::new(&server.url, "");
        config.model = embedding_text(EmbeddingText::from_codepoints(&model).unwrap());
        let mut embedder = LlamaEmbedder::new(config);
        embedder.proxies = ProxySettings::default();
        let vector = embedder
            .request_embedding_text(
                EmbeddingText::from_codepoints(&input).unwrap(),
                EmbeddingKind::Query,
            )
            .unwrap();
        assert_eq!(
            vector
                .iter()
                .map(|value| value.to_bits())
                .collect::<Vec<_>>(),
            case["bits"]
                .as_array()
                .unwrap()
                .iter()
                .map(|value| value.as_u64().unwrap())
                .collect::<Vec<_>>()
        );
        assert_eq!(
            embedder.name().codepoints().as_ref(),
            points(&case["nameCodepoints"])
        );
        assert_eq!(
            embedder.dimensions(),
            case["dimensions"].as_u64().unwrap() as usize
        );
        assert_eq!(
            server.next().body,
            case["bodyAscii"].as_str().unwrap().as_bytes()
        );
    }
}
fn points(value: &serde_json::Value) -> Vec<u32> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|cp| u32::try_from(cp.as_u64().unwrap()).unwrap())
        .collect()
}
#[test]
fn actual_python_lossless_query_store_views_match_without_reencoding_persisted_data() {
    use reverie_store::memory::{MemoryStore, ReflectionInput, RetrievalOptions};
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../tests/fixtures/memory-codepoint-embeddings-python.json"
    ))
    .unwrap();
    let store =
        MemoryStore::open_with(":memory:", Arc::new(HashedEmbedder::new(64)), 0.995).unwrap();
    let mut input = ReflectionInput::new("compiler", 7.0, &[]);
    input.created_at = Some(100.0);
    store.add_reflection(input).unwrap();
    for case in fixture["storeQueries"].as_array().unwrap() {
        let text = points(&case["textCodepoints"]);
        let result = store
            .retrieve_text(
                EmbeddingText::from_codepoints(&text).unwrap(),
                RetrievalOptions {
                    now: Some(1000.0),
                    ..Default::default()
                },
            )
            .unwrap();
        let actual = result
            .iter()
            .map(|memory| String::from_utf8(memory.as_dict_json()).unwrap())
            .collect::<Vec<_>>();
        let expected = case["viewsJson"]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value.as_str().unwrap().to_owned())
            .collect::<Vec<_>>();
        assert_eq!(actual, expected);
    }
    store.close().unwrap();
}
#[test]
fn non_scalar_model_names_fail_at_real_sql_binding_after_post_and_external_claim() {
    use reverie_store::memory::{EpisodeInput, MemoryError, MemoryStore, RetrievalOptions};
    let server = Server::new(vec![
        response(
            "200 OK",
            "",
            br#"{"data":[{"embedding":[3,4]}]}"#
        );
        3
    ]);
    let mut config = LlamaConfig::new(&server.url, "");
    let raw = [0xd800];
    config.model = embedding_text(EmbeddingText::from_codepoints(&raw).unwrap());
    let mut model = LlamaEmbedder::new(config);
    model.proxies = ProxySettings::default();
    let store = MemoryStore::open_with(":memory:", Arc::new(model), 0.995).unwrap();
    assert!(
        store
            .add_episode(EpisodeInput::new("user", "assistant"))
            .is_err()
    );
    assert_eq!(store.count(None).unwrap(), 0);
    server.next();
    assert!(
        store
            .retrieve_text(
                EmbeddingText::from_codepoints(&raw).unwrap(),
                RetrievalOptions::default()
            )
            .is_err()
    );
    server.next();
    store
        .atomic(|tx| {
            assert!(
                tx.add_external_episode("synthetic:orphan", "user", "assistant", "private")
                    .is_err()
            );
            Ok(())
        })
        .unwrap();
    server.next();
    let name = store.embedder_name().unwrap();
    assert_eq!(name.codepoints(), [108, 108, 97, 109, 97, 58, 0xd800]);
    assert!(name.scalar_text().is_none());
    store
        .set_embedder(Arc::new(HashedEmbedder::new(16)))
        .unwrap();
    assert!(matches!(
        store.add_external_episode("synthetic:orphan", "user", "assistant", "private"),
        Err(MemoryError::MissingExternalMemory)
    ));
    assert_eq!(store.count(None).unwrap(), 0);
    store.close().unwrap();
}
#[test]
fn non_scalar_document_posts_losslessly_before_its_sql_text_refusal() {
    use reverie_store::memory::{EpisodeInput, MemoryStore};
    let server = Server::new(vec![response(
        "200 OK",
        "",
        br#"{"data":[{"embedding":[3,4]}]}"#,
    )]);
    let model = embedder(server.url.clone());
    let store = MemoryStore::open_with(":memory:", Arc::new(model), 0.995).unwrap();
    let input = EpisodeInput::from_text(
        embedding_text(EmbeddingText::from_codepoints(&[0xd800]).unwrap()),
        MetadataText::from_scalar_text("answer"),
    );
    assert!(store.add_episode(input).is_err());
    assert_eq!(store.count(None).unwrap(), 0);
    let request = server.next();
    assert_eq!(
        request.body,
        br#"{"input": "search_document: User: \ud800\nAssistant: answer", "model": "model"}"#
    );
    store.close().unwrap();
}
#[test]
fn actual_python_unicode_authorities_preserve_latin1_host_and_idna_local_routes() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../tests/fixtures/memory-unicode-http-python.json"
    ))
    .unwrap();
    for case in fixture["cases"].as_array().unwrap() {
        let expected = case["requests"].as_array().unwrap();
        let server = Server::new(vec![
            response(
                "200 OK",
                "",
                br#"{"data":[{"embedding":[3,4]}]}"#
            );
            expected.len()
        ]);
        let port = server.url.rsplit(':').next().unwrap();
        let url = case["urlTemplate"].as_str().unwrap().replace("PORT", port);
        let mut model = embedder(url);
        if let Some(proxy) = case["proxyTemplate"].as_str() {
            model.proxies = ProxySettings::from_pairs(vec![(
                "http_proxy".into(),
                proxy.replace("PORT", port).into(),
            )]);
        }
        let result = model.request_embedding("unicode host", EmbeddingKind::Document);
        if case.get("error").is_some() {
            assert!(matches!(result, Err(LlamaError::InvalidEndpoint)));
            continue;
        }
        assert_eq!(result.unwrap(), [0.6, 0.8]);
        let request = server.next();
        let expected = &expected[0];
        assert_eq!(request.first, expected["first"].as_str().unwrap());
        let host = expected["hostBytesTemplate"]
            .as_array()
            .unwrap()
            .iter()
            .map(|byte| char::from(u8::try_from(byte.as_u64().unwrap()).unwrap()))
            .collect::<String>()
            .replace("PORT", port);
        assert_eq!(request.header("host"), Some(host.as_str()));
        assert_eq!(
            request.header("proxy-authorization").unwrap_or(""),
            expected["proxyAuthorization"].as_str().unwrap()
        );
        assert_eq!(
            request.body,
            expected["bodyAscii"].as_str().unwrap().as_bytes()
        );
    }
}
