//! Own the fixture's loopback port for its full lifetime. Guard regressions can
//! reach only this bounded refusal server, never an unrelated host website.
use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

pub(super) struct Health {
    port: u16,
    requests: Arc<AtomicUsize>,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}
impl Health {
    pub(super) fn start() -> Self {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(
            port >= 1024 && port != 3000,
            "Fixture must own an ephemeral port"
        );
        listener.set_nonblocking(true).unwrap();
        let requests = Arc::new(AtomicUsize::new(0));
        let stop = Arc::new(AtomicBool::new(false));
        let inputs = (requests.clone(), stop.clone());
        let thread = thread::spawn(move || serve(listener, inputs));
        Self {
            port,
            requests,
            stop,
            thread: Some(thread),
        }
    }
    pub(super) fn port(&self) -> u16 {
        self.port
    }
    pub(super) fn requests(&self) -> usize {
        self.requests.load(Ordering::Acquire)
    }
}
impl Drop for Health {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        self.thread.take().unwrap().join().unwrap();
    }
}
fn serve(listener: TcpListener, inputs: (Arc<AtomicUsize>, Arc<AtomicBool>)) {
    let (requests, stop) = inputs;
    while !stop.load(Ordering::Acquire) {
        match listener.accept() {
            Ok((stream, _)) => {
                requests.fetch_add(1, Ordering::AcqRel);
                refuse(stream);
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(1))
            }
            Err(error) => panic!("owned fixture health accept: {error}"),
        }
    }
}
fn refuse(mut stream: TcpStream) {
    stream
        .set_read_timeout(Some(Duration::from_millis(100)))
        .unwrap();
    stream
        .set_write_timeout(Some(Duration::from_millis(100)))
        .unwrap();
    let mut head = Vec::new();
    let end = Instant::now() + Duration::from_millis(100);
    while !head.ends_with(b"\r\n\r\n") && head.len() < 8192 && Instant::now() < end {
        let mut byte = [0];
        if stream.read_exact(&mut byte).is_err() {
            break;
        }
        head.push(byte[0]);
    }
    let _ = stream.write_all(
        b"HTTP/1.1 503 Service Unavailable\r\nContent-Length:0\r\nConnection:close\r\n\r\n",
    );
}

#[test]
fn owned_health_port_returns_refusal_and_counts_the_unexpected_read() {
    let health = Health::start();
    assert_eq!(health.requests(), 0);
    assert!(TcpListener::bind(("127.0.0.1", health.port())).is_err());
    let mut stream = TcpStream::connect(("127.0.0.1", health.port())).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(1)))
        .unwrap();
    stream
        .write_all(b"GET /api/status HTTP/1.1\r\nHost:fixture\r\n\r\n")
        .unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).unwrap();
    assert!(response.starts_with("HTTP/1.1 503 "));
    assert_eq!(health.requests(), 1);
    drop(health); // Joins the listener before releasing its port.
}
