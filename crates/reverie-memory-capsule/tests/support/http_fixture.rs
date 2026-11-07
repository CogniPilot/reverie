//! Fixed test responder only. Actual Company/ServiceGrant/Office authorization
//! remains separately qualified; this does not simulate an authority producer.
use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::Duration,
};
pub(super) struct Fixture {
    address: String,
    stopped: Arc<AtomicBool>,
    received: Arc<Mutex<Vec<String>>>,
    task: Option<thread::JoinHandle<()>>,
}
impl Fixture {
    pub(super) fn new(refuse: bool) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap().to_string();
        let stopped = Arc::new(AtomicBool::new(false));
        let received = Arc::new(Mutex::new(Vec::new()));
        let flag = stopped.clone();
        let requests = received.clone();
        let task = thread::spawn(move || server(listener, refuse, &flag, &requests));
        Self {
            address,
            stopped,
            received,
            task: Some(task),
        }
    }
    pub(super) fn url(&self) -> String {
        format!("http://{}", self.address)
    }
    pub(super) fn finish(mut self) -> Vec<String> {
        self.stop();
        self.received.lock().unwrap().clone()
    }
    fn stop(&mut self) {
        self.stopped.store(true, Ordering::Release);
        if let Some(task) = self.task.take() {
            task.join().unwrap();
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.stop();
    }
}
fn server(listener: TcpListener, refuse: bool, flag: &AtomicBool, requests: &Mutex<Vec<String>>) {
    while !flag.load(Ordering::Acquire) {
        match listener.accept() {
            Ok((stream, _)) => serve(stream, refuse, requests),
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(5))
            }
            Err(error) => panic!("owned listener: {error}"),
        }
    }
}
fn serve(mut stream: TcpStream, refuse: bool, requests: &Mutex<Vec<String>>) {
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    stream
        .set_write_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    let mut bytes = Vec::new();
    let mut byte = [0];
    while !bytes.ends_with(b"\r\n\r\n") {
        stream.read_exact(&mut byte).unwrap();
        bytes.push(byte[0]);
        assert!(bytes.len() < 65536, "bounded fixed-fixture request head");
    }
    let header = String::from_utf8(bytes).unwrap();
    assert!(
        fields(&header, "Parent-Session").is_empty(),
        "no Office authority header is manufactured"
    );
    assert_eq!(
        fields(&header, "Authorization"),
        ["Basic Y2Fwc3VsZS11c2VyOmZpeHR1cmUtcGFzc3dvcmQ="]
    );
    let citations = fields(&header, "X-Reverie-Parent-Session");
    if refuse {
        // Ordinary authenticated-user client citation, not Office's fixed
        // Parent-Session/host service boundary. This endpoint always refuses.
        assert_eq!(citations, ["10000000-0000-4000-8000-000000000001"]);
    } else {
        assert!(citations.is_empty());
    }
    let length = header
        .lines()
        .find_map(|line| {
            line.split_once(':')
                .filter(|(name, _)| name.eq_ignore_ascii_case("content-length"))
                .map(|(_, value)| value.trim().parse::<usize>().unwrap())
        })
        .unwrap_or(0);
    assert!(length < 1024 * 1024);
    let mut body = vec![0; length];
    stream.read_exact(&mut body).unwrap();
    requests.lock().unwrap().push(header);
    let (status, body) = if refuse {
        (
            "401 Unauthorized",
            r#"{"success":false,"error":"owned transport refusal"}"#,
        )
    } else {
        (
            "200 OK",
            r#"{"success":true,"data":[{"id":"owned-transport-session","name":"synthetic","mode":"shell","status":"idle"}]}"#,
        )
    };
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(response.as_bytes()).unwrap();
}
fn fields<'a>(header: &'a str, name: &str) -> Vec<&'a str> {
    header
        .lines()
        .skip(1)
        .filter_map(|line| line.split_once(':'))
        .filter(|(key, _)| key.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.trim())
        .collect()
}
#[test]
fn client_citation_is_distinct_from_exact_authority_header_and_duplicates() {
    let header = "GET / HTTP/1.1\r\nX-Reverie-Parent-Session: citation\r\n\r\n";
    assert!(fields(header, "Parent-Session").is_empty());
    assert_eq!(fields(header, "X-Reverie-Parent-Session"), ["citation"]);
    let header = "GET / HTTP/1.1\r\nX-Reverie-Parent-Session: citation\r\npArEnT-sEsSiOn: authority\r\nParent-Session: duplicate\r\n\r\n";
    assert_eq!(fields(header, "Parent-Session"), ["authority", "duplicate"]);
}
