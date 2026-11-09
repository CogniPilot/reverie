//! Real Unix HTTP peers exercise cancellation and byte/identity boundaries.
//! These are not an engine, immutable website, owner or Q authority fixture.
use super::*;
use reverie_core::{PythonText, decimal::UnsignedInteger};
use std::{
    fs,
    io::{Read, Write},
    os::unix::{
        fs::{DirBuilderExt, MetadataExt},
        net::{UnixListener, UnixStream},
    },
    sync::atomic::{AtomicU64, Ordering},
    thread,
    time::{Duration, Instant},
};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture {
    root: PathBuf,
    listener: UnixListener,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "webfacts-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
        let listener = UnixListener::bind(root.join("s")).unwrap();
        Self { root, listener }
    }
    fn observer(&self) -> WebsiteMetadataObserver {
        let path = self.root.join("s");
        let info = fs::symlink_metadata(&path).unwrap();
        WebsiteMetadataObserver::new(&EngineSelection {
            socket: PythonText::try_new(native::python_text(&path)).unwrap(),
            identity: [
                info.dev(),
                info.ino(),
                u64::from(info.uid()),
                u64::from(info.gid()),
            ]
            .map(UnsignedInteger::from_u64),
            id: "fixed-engine".into(),
        })
        .unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root).unwrap();
    }
}
fn end() -> Instant {
    Instant::now() + Duration::from_secs(5)
}
fn accepted(listener: &UnixListener) -> UnixStream {
    let (stream, _) = listener.accept().unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(4)))
        .unwrap();
    stream
        .set_write_timeout(Some(Duration::from_secs(4)))
        .unwrap();
    stream
}
fn head(stream: &mut UnixStream) -> Vec<u8> {
    let mut output = Vec::new();
    while !output.ends_with(b"\r\n\r\n") {
        let mut byte = [0];
        stream.read_exact(&mut byte).unwrap();
        output.push(byte[0]);
        assert!(output.len() < 8192);
    }
    output
}
fn reply(stream: &mut UnixStream, body: &[u8]) {
    write!(
        stream,
        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n",
        body.len()
    )
    .unwrap();
    stream.write_all(body).unwrap();
}
fn progressing_header(stream: &mut UnixStream) {
    stream.write_all(b"HTTP/1.1 200 OK\r\nX-Slow: ").unwrap();
    for _ in 0..30 {
        if stream.write_all(b"x").is_err() {
            break;
        }
        thread::sleep(Duration::from_millis(20));
    }
}
#[test]
fn actual_fixed_routes_and_same_kernel_are_metadata_only() {
    let fixture = Fixture::new();
    let mut observer = fixture.observer();
    let digest = JournalDigest::parse(&"a".repeat(64)).unwrap();
    let paths = [
        "/info".to_string(),
        "/containers/json?all=1".into(),
        format!("/containers/{}/json", digest.as_str()),
        format!("/images/sha256:{}/json", digest.as_str()),
    ];
    thread::scope(|scope| {
        let server = scope.spawn(|| {
            for path in &paths {
                let mut stream = accepted(&fixture.listener);
                let request = head(&mut stream);
                assert!(request.starts_with(format!("GET {path} HTTP/1.1\r\n").as_bytes()));
                reply(&mut stream, br#"{"key":1,"key":2}"#);
            }
            let mut stream = accepted(&fixture.listener);
            assert!(head(&mut stream).starts_with(b"GET /info HTTP/1.1\r\n"));
            reply(&mut stream, &serde_json::to_vec(&serde_json::json!({
                "ID":"fixed-engine", "OSType":"linux", "KernelVersion":native::kernel_release().unwrap()
            })).unwrap());
        });
        let results = [
            WebsiteMetadataRoute::Info,
            WebsiteMetadataRoute::Containers,
            WebsiteMetadataRoute::Container(digest.clone()),
            WebsiteMetadataRoute::Image(digest),
        ]
        .map(|route| observer.observe(route, end()));
        let kernel = observer.guard_same_kernel(end());
        server.join().unwrap();
        let expected = EngineMetadata::decode(br#"{"key":2}"#).unwrap();
        for result in results {
            assert!(result.unwrap().equivalent(&expected));
        }
        kernel.unwrap();
    });
}
#[test]
fn progressing_headers_obey_one_deadline_and_close_before_next_request() {
    let fixture = Fixture::new();
    let mut observer = fixture.observer();
    thread::scope(|scope| {
        let server = scope.spawn(|| {
            let mut stream = accepted(&fixture.listener);
            head(&mut stream);
            progressing_header(&mut stream);
            let mut byte = [0];
            assert_eq!(
                stream.read(&mut byte).unwrap(),
                0,
                "same socket closed before another runtime poll"
            );
            let mut next = accepted(&fixture.listener);
            head(&mut next);
            reply(&mut next, b"{}");
        });
        let start = Instant::now();
        let first = observer.observe(
            WebsiteMetadataRoute::Info,
            start + Duration::from_millis(140),
        );
        let elapsed = start.elapsed();
        let next = observer.observe(WebsiteMetadataRoute::Info, end());
        server.join().unwrap();
        assert_eq!(first.err().unwrap().code(), "ENGINE_METADATA_DEADLINE");
        assert!(
            elapsed < Duration::from_millis(600),
            "progress restarted deadline: {elapsed:?}"
        );
        next.unwrap();
    });
}
#[test]
fn actual_socket_rebinding_is_refused_before_contacting_replacement() {
    let fixture = Fixture::new();
    let mut observer = fixture.observer();
    fs::remove_file(fixture.root.join("s")).unwrap();
    let replacement = UnixListener::bind(fixture.root.join("s")).unwrap();
    replacement.set_nonblocking(true).unwrap();
    let result = observer.observe(WebsiteMetadataRoute::Info, end());
    assert_eq!(result.err().unwrap().code(), "ENGINE_SOCKET_REBOUND");
    assert_eq!(
        replacement.accept().unwrap_err().kind(),
        io::ErrorKind::WouldBlock
    );
}
#[test]
fn incomplete_and_oversized_bodies_cannot_become_engine_facts() {
    let fixture = Fixture::new();
    let mut observer = fixture.observer();
    thread::scope(|scope| {
        let server = scope.spawn(|| {
            let mut first = accepted(&fixture.listener);
            head(&mut first);
            first
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 20\r\n\r\n{}")
                .unwrap();
            drop(first);
            let mut second = accepted(&fixture.listener);
            head(&mut second);
            write!(
                second,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n",
                engine::MAX_BODY + 1
            )
            .unwrap();
        });
        let first = observer.observe(WebsiteMetadataRoute::Info, end());
        let second = observer.observe(WebsiteMetadataRoute::Info, end());
        server.join().unwrap();
        assert!(first.is_err());
        assert!(second.is_err());
    });
}
#[test]
fn header_overhead_is_counted_in_actual_wire_bound() {
    let fixture = Fixture::new();
    let mut observer = fixture.observer();
    let _ = transport::take_wire_bound_rejections();
    thread::scope(|scope| {
        let server = scope.spawn(|| {
            let mut stream = accepted(&fixture.listener);
            head(&mut stream);
            // Valid header lines/count isolate total-wire rejection without
            // relying on throughput through 400,000 tiny body chunks.
            let mut wire = b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n".to_vec();
            for index in 0..34 {
                write!(&mut wire, "X-Wire-{index}: ").unwrap();
                wire.resize(wire.len() + 65_000, b'x');
                wire.extend_from_slice(b"\r\n");
            }
            wire.extend_from_slice(b"\r\n{}");
            let _ = stream.write_all(&wire);
        });
        let result = observer.observe(WebsiteMetadataRoute::Info, end());
        server.join().unwrap();
        let rejections = transport::take_wire_bound_rejections();
        assert!(
            result.is_err(),
            "small decoded JSON must not hide excessive header wire bytes"
        );
        assert!(
            rejections > 0,
            "the actual wire-bound branch must reject, rather than a deadline or parser error"
        );
    });
}
#[test]
fn consumed_close_uncertainty_is_sticky_and_never_recontacts_engine() {
    let fixture = Fixture::new();
    let mut observer = fixture.observer();
    thread::scope(|scope| {
        let server = scope.spawn(|| {
            let mut stream = accepted(&fixture.listener);
            head(&mut stream);
            reply(&mut stream, b"{}");
        });
        native::test_faults::set(None, true);
        let first = observer.observe(WebsiteMetadataRoute::Info, end());
        server.join().unwrap();
        assert_eq!(
            first.err().unwrap().code(),
            "ENGINE_METADATA_CLOSE_UNCONFIRMED"
        );
        fixture.listener.set_nonblocking(true).unwrap();
        let second = observer.observe(WebsiteMetadataRoute::Info, end());
        assert_eq!(
            second.err().unwrap().code(),
            "ENGINE_METADATA_CLOSE_UNCONFIRMED"
        );
        assert_eq!(
            fixture.listener.accept().unwrap_err().kind(),
            io::ErrorKind::WouldBlock
        );
    });
}
