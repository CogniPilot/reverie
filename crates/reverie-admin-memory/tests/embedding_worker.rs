use reverie_core::memory::{Embedder, EmbeddingKind, EmbeddingText, HashedEmbedder};
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Read, Write},
    net::TcpListener,
    os::unix::process::CommandExt,
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    thread,
    time::Duration,
};

struct Worker {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
}

impl Worker {
    fn start(dimensions: &str, endpoint: Value, model: &str, size: usize) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_reverie-admin-memory"))
            .arg(format!("--embedding-worker={}", std::process::id()))
            .env_clear()
            .process_group(0)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let input = child.stdin.take().unwrap();
        let output = BufReader::new(child.stdout.take().unwrap());
        let mut worker = Self {
            child,
            input,
            output,
        };
        worker.send(json!({"dimensions": dimensions, "endpoint": endpoint}));
        let mut response = String::new();
        worker.output.read_line(&mut response).unwrap();
        let name: Vec<u32> = model.chars().map(u32::from).collect();
        assert_eq!(
            serde_json::from_str::<(Vec<u32>, usize)>(&response).unwrap(),
            (name, size)
        );
        worker
    }
    fn send(&mut self, request: Value) {
        writeln!(self.input, "{request}").unwrap();
    }
    fn embedding(&mut self, text: &[u32], query: bool) -> Option<Vec<u64>> {
        self.send(json!({"text": text, "query": query}));
        let count = next_word(&mut self.output);
        (count != u64::MAX).then(|| (0..count).map(|_| next_word(&mut self.output)).collect())
    }
    fn finish(mut self) {
        drop(self.input);
        assert!(self.child.wait().unwrap().success());
    }
}

fn next_word(input: &mut impl Read) -> u64 {
    let mut bytes = [0; 8];
    input.read_exact(&mut bytes).unwrap();
    u64::from_le_bytes(bytes)
}

#[test]
fn vectors_preserve_hash_identity_and_bits_after_a_failed_endpoint_probe() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("https://{}", listener.local_addr().unwrap());
    drop(listener);
    let endpoint = json!({
        "url": url.chars().map(u32::from).collect::<Vec<_>>(),
        "model": [], "document_prefix": [], "query_prefix": []
    });
    let mut worker = Worker::start("32", endpoint, "hashed-v1-32", 32);
    let mut text: Vec<u32> = "Rust rust recall".chars().map(u32::from).collect();
    text.push(0xd800);
    let expected: Vec<_> = HashedEmbedder::new(32)
        .embed_text(
            EmbeddingText::from_codepoints(&text).unwrap(),
            EmbeddingKind::Query,
        )
        .unwrap()
        .into_iter()
        .map(f64::to_bits)
        .collect();
    assert_eq!(worker.embedding(&text, true).unwrap(), expected);
    assert_eq!(worker.embedding(&[], false).unwrap(), vec![0; 32]);
    worker.finish();
}

#[test]
fn configured_stream_retains_model_and_prefixes_after_request_failure() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let codepoints = |text: &str| text.chars().map(u32::from).collect::<Vec<_>>();
    let endpoint = json!({
        "url": codepoints(&format!("http://{}/v1/", listener.local_addr().unwrap())),
        "model": codepoints("synthetic"),
        "document_prefix": codepoints("doc:"),
        "query_prefix": codepoints("query:")
    });
    let server = thread::spawn(move || {
        respond(
            &listener,
            "doc:probe",
            "200 OK",
            r#"{"data":[{"embedding":[3,4]}]}"#,
        );
        respond(&listener, "query:missing", "503 Unavailable", "{}");
        respond(
            &listener,
            "query:next",
            "200 OK",
            r#"{"data":[{"embedding":[-0.0,1]}]}"#,
        );
    });
    let mut worker = Worker::start("32", endpoint, "llama:synthetic", 2);
    assert_eq!(worker.embedding(&codepoints("missing"), true), None);
    assert_eq!(
        worker.embedding(&codepoints("next"), true).unwrap(),
        vec![(-0.0_f64).to_bits(), 1.0_f64.to_bits()]
    );
    worker.finish();
    server.join().unwrap();
}

fn respond(listener: &TcpListener, input: &str, status: &str, body: &str) {
    let (mut stream, _) = listener.accept().unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    let mut reader = BufReader::new(&mut stream);
    let mut first = String::new();
    reader.read_line(&mut first).unwrap();
    assert_eq!(first, "POST /v1/embeddings HTTP/1.1\r\n");
    let headers: Vec<_> = reader
        .by_ref()
        .lines()
        .take_while(|line| line.as_ref().is_ok_and(|line| !line.is_empty()))
        .collect::<Result<_, _>>()
        .unwrap();
    let length = headers
        .iter()
        .find_map(|line| {
            line.to_ascii_lowercase()
                .strip_prefix("content-length: ")?
                .parse::<usize>()
                .ok()
        })
        .unwrap();
    let mut request = vec![0; length];
    reader.read_exact(&mut request).unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&request).unwrap(),
        json!({"input": input, "model": "synthetic"})
    );
    write!(
        stream,
        "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
    .unwrap();
}
