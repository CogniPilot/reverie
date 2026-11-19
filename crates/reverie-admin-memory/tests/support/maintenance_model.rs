use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Read, Write},
    net::{TcpListener, TcpStream},
    thread,
    time::{Duration, Instant},
};
pub(super) fn serve_model(
    replies: Vec<Option<String>>,
) -> (String, thread::JoinHandle<Vec<Value>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let base = format!("http://{}/v1", listener.local_addr().unwrap());
    let task = thread::spawn(move || {
        let mut requests = Vec::new();
        for reply in replies {
            let mut client = accept(&listener);
            client
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            requests.push(read_request(&mut client));
            let (status, body) = match reply {
                Some(text) => (
                    "200 OK",
                    json!({"choices":[{"message":{"content":text}}]}).to_string(),
                ),
                None => ("503 Unavailable", "{}".to_owned()),
            };
            write!(client, "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}", body.len()).unwrap();
        }
        requests
    });
    (base, task)
}

fn accept(listener: &TcpListener) -> TcpStream {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match listener.accept() {
            Ok((stream, _)) => return stream,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                assert!(Instant::now() < deadline, "model request did not arrive");
                thread::sleep(Duration::from_millis(5));
            }
            Err(error) => panic!("{error}"),
        }
    }
}

fn read_request(client: &mut TcpStream) -> Value {
    let mut reader = BufReader::new(client);
    let mut line = String::new();
    reader.read_line(&mut line).unwrap();
    assert!(line.starts_with("POST /v1/chat/completions "));
    let mut len = None;
    loop {
        line.clear();
        assert_ne!(reader.read_line(&mut line).unwrap(), 0);
        if line == "\r\n" {
            break;
        }
        if let Some((key, value)) = line.split_once(':')
            && key.eq_ignore_ascii_case("content-length")
        {
            len = Some(value.trim().parse().unwrap());
        }
    }
    let mut body = vec![0; len.unwrap()];
    reader.read_exact(&mut body).unwrap();
    serde_json::from_slice(&body).unwrap()
}
