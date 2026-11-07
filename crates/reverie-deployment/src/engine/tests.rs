use super::*;
use std::{
    io::{Read, Write},
    os::unix::net::UnixListener,
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc,
    },
    thread,
};

static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture {
    directory: PathBuf,
    listener: UnixListener,
}
impl Fixture {
    fn new() -> Self {
        let directory = std::env::temp_dir().join(format!(
            "dep-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&directory).unwrap();
        let listener = UnixListener::bind(directory.join("s")).unwrap();
        Self {
            directory,
            listener,
        }
    }
    fn engine(&self) -> Engine {
        Engine::new(&self.directory.join("s")).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}
fn read_head(stream: &mut std::os::unix::net::UnixStream) -> Vec<u8> {
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    let mut bytes = Vec::new();
    while !bytes.ends_with(b"\r\n\r\n") {
        let mut byte = [0];
        stream.read_exact(&mut byte).unwrap();
        bytes.push(byte[0]);
        assert!(bytes.len() < 8192);
    }
    bytes
}
fn accept(listener: &UnixListener) -> std::os::unix::net::UnixStream {
    listener.set_nonblocking(true).unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(3);
    loop {
        match listener.accept() {
            Ok((stream, _)) => {
                stream.set_nonblocking(false).unwrap();
                return stream;
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                assert!(
                    std::time::Instant::now() < deadline,
                    "fixture connection absent"
                );
                thread::sleep(Duration::from_millis(2));
            }
            Err(error) => panic!("fixture accept: {error}"),
        }
    }
}
fn status(listener: &UnixListener) {
    let mut stream = accept(listener);
    let head = read_head(&mut stream);
    assert!(head.starts_with(b"GET /containers/known/json HTTP/1.1\r\n"));
    stream
        .write_all(b"HTTP/1.1 200 OK\r\nContent-Length:11\r\nConnection:close\r\n\r\n{\"ok\":true}")
        .unwrap();
}
fn request(
    engine: &Engine,
    method: &str,
    path: &str,
    body: Option<&Value>,
    timeout: Duration,
) -> Result<Value> {
    engine.json_with_policy(method, path, body, timeout, nix::unistd::getuid().as_raw())
}
#[test]
fn response_timeout_closes_actual_connection_before_later_status() {
    let fixture = Fixture::new();
    let listener = fixture.listener.try_clone().unwrap();
    let (release, released) = mpsc::channel();
    let (closed, closure) = mpsc::channel();
    thread::scope(|scope| {
        let server = scope.spawn(move || {
            let mut stream = accept(&listener);
            assert!(
                read_head(&mut stream).starts_with(b"POST /containers/known/start HTTP/1.1\r\n")
            );
            released.recv_timeout(Duration::from_secs(3)).unwrap();
            let mut byte = [0];
            assert_eq!(
                stream.read(&mut byte).unwrap(),
                0,
                "timed-out sender must close its socket"
            );
            closed.send(()).unwrap();
            status(&listener);
        });
        let engine = fixture.engine();
        let error = request(
            &engine,
            "POST",
            "/containers/known/start",
            None,
            Duration::from_millis(100),
        )
        .unwrap_err();
        assert_eq!(error.code(), "DEPLOYMENT_ENGINE_RESPONSE_UNKNOWN");
        release.send(()).unwrap();
        closure
            .recv_timeout(Duration::from_secs(1))
            .expect("socket must settle without polling the Engine runtime again");
        assert_eq!(
            request(
                &engine,
                "GET",
                "/containers/known/json",
                None,
                Duration::from_secs(3)
            )
            .unwrap(),
            serde_json::json!({"ok":true})
        );
        server.join().unwrap();
    });
}
#[test]
fn request_backpressure_timeout_never_resumes_body_on_next_call() {
    let fixture = Fixture::new();
    let listener = fixture.listener.try_clone().unwrap();
    let (release, released) = mpsc::channel();
    let (closed, closure) = mpsc::channel();
    thread::scope(|scope| {
        let server = scope.spawn(move || {
            let mut stream = accept(&listener);
            assert!(read_head(&mut stream).starts_with(b"POST /containers/create HTTP/1.1\r\n"));
            released.recv_timeout(Duration::from_secs(5)).unwrap();
            let mut remaining = Vec::new();
            stream.read_to_end(&mut remaining).unwrap();
            assert!(
                remaining.len() < 2 * 1024 * 1024,
                "timed-out driver must not complete pending body"
            );
            closed.send(()).unwrap();
            status(&listener);
        });
        let engine = fixture.engine();
        let body = serde_json::json!({"fixture":"x".repeat(2 * 1024 * 1024)});
        let error = request(
            &engine,
            "POST",
            "/containers/create",
            Some(&body),
            Duration::from_millis(750),
        )
        .unwrap_err();
        assert_eq!(error.code(), "DEPLOYMENT_ENGINE_RESPONSE_UNKNOWN");
        release.send(()).unwrap();
        closure
            .recv_timeout(Duration::from_secs(1))
            .expect("body socket must settle without polling the Engine runtime again");
        assert_eq!(
            request(
                &engine,
                "GET",
                "/containers/known/json",
                None,
                Duration::from_secs(3)
            )
            .unwrap()["ok"],
            true
        );
        server.join().unwrap();
    });
}
