use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread::{self, JoinHandle},
    time::Duration,
};

// A deterministic owned transport fixture, never a real-ASR qualification.
pub(super) struct Server {
    url: String,
    stop: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}

impl Server {
    pub(super) fn start(case: &'static str) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        listener.set_nonblocking(true).unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let done = Arc::clone(&stop);
        let worker = thread::spawn(move || run(listener, done, case));
        Self {
            url,
            stop,
            worker: Some(worker),
        }
    }

    pub(super) fn url(&self) -> String {
        self.url.clone()
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        self.worker
            .take()
            .unwrap()
            .join()
            .expect("fixture thread settled");
    }
}

fn run(listener: TcpListener, done: Arc<AtomicBool>, case: &str) {
    while !done.load(Ordering::Acquire) {
        match listener.accept() {
            Ok((mut stream, _)) => serve(&mut stream, case),
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(2));
            }
            Err(error) => panic!("listener: {error}"),
        }
    }
}

fn serve(stream: &mut TcpStream, case: &str) {
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    stream
        .set_write_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let mut bytes = Vec::new();
    let mut block = [0; 8192];
    let (header, length) = loop {
        let count = stream.read(&mut block).expect("HTTP request");
        assert_ne!(count, 0);
        bytes.extend_from_slice(&block[..count]);
        assert!(bytes.len() <= 1024 * 1024);
        if let Some(end) = bytes.windows(4).position(|v| v == b"\r\n\r\n") {
            let text = String::from_utf8_lossy(&bytes[..end]);
            assert!(text.starts_with("POST /stt HTTP/1.1\r\n"));
            let length = text
                .lines()
                .find_map(|line| {
                    let (key, value) = line.split_once(':')?;
                    key.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse::<usize>().unwrap())
                })
                .expect("body length");
            break (end + 4, length);
        }
    };
    while bytes.len() < header + length {
        let count = stream.read(&mut block).unwrap();
        assert_ne!(count, 0);
        bytes.extend_from_slice(&block[..count]);
    }
    let fixture: serde_json::Value = serde_json::from_str(super::fixture::FIXTURE).unwrap();
    let transcript = if length > 160044 || case == "asr-negative" {
        &fixture["reply"]
    } else {
        &fixture["input"]
    };
    let body = match case {
        "json" => "not json".to_owned(),
        "empty-asr" => serde_json::json!({"transcript":""}).to_string(),
        _ => serde_json::json!({"transcript":transcript}).to_string(),
    };
    let status = if case == "http" {
        "503 Unavailable"
    } else {
        "200 OK"
    };
    write!(stream, "HTTP/1.1 {status}\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
}
