use super::*;
use std::net::TcpListener;
#[derive(Clone, Copy)]
pub(super) enum ReplyMode {
    Allowed,
    Revoked,
}
pub(super) fn serve(
    count: usize,
    mode: ReplyMode,
    company: Option<PathBuf>,
) -> std::thread::JoinHandle<Vec<String>> {
    let listener = TcpListener::bind("127.0.0.1:3000").unwrap();
    listener.set_nonblocking(true).unwrap();
    std::thread::spawn(move || {
        let end = Instant::now() + Duration::from_secs(25);
        let mut requests = Vec::new();
        for index in 0..count {
            let mut stream = accept(&listener, end);
            stream
                .set_read_timeout(Some(Duration::from_secs(10)))
                .unwrap();
            let mut request = Vec::new();
            while !request.ends_with(b"\r\n\r\n") {
                let mut byte = [0];
                stream.read_exact(&mut byte).unwrap();
                request.push(byte[0]);
            }
            let request = String::from_utf8(request).unwrap();
            let file = index % 3 == 1;
            let target = if file {
                format!("/api/v1/chatrooms/{RID}/files/{FID}")
            } else {
                format!("/api/v1/chatrooms/{RID}/messages/{MID}")
            };
            assert!(request.starts_with(&format!("GET {target} HTTP/1.1")));
            assert!(
                request
                    .to_ascii_lowercase()
                    .contains(&format!("x-reverie-parent-session: {SID}"))
            );
            assert!(
                request
                    .to_ascii_lowercase()
                    .contains("authorization: basic ")
            );
            let removed = matches!(mode, ReplyMode::Revoked) && index % 3 == 2;
            let message=serde_json::to_vec(&json!({"success":true,"data":{"message":{"id":MID,"attachments":if removed {json!([])} else {json!([{"id":FID,"type":"image/png"}])}}}})).unwrap();
            let bytes = if file { PNG } else { &message };
            let mime = if file {
                "image/png"
            } else {
                "application/json"
            };
            write!(stream,"HTTP/1.1 200 OK\r\nContent-Length: {}\r\nContent-Type: {mime}\r\nConnection: close\r\n\r\n",bytes.len()).unwrap();
            stream.write_all(bytes).unwrap();
            if file && let Some(company) = &company {
                let mut value: Json = serde_json::from_slice(&fs::read(company).unwrap()).unwrap();
                value["employees"][0]["desiredRunning"] = json!(false);
                fs::write(company, serde_json::to_vec(&value).unwrap()).unwrap();
            }
            requests.push(request);
        }
        requests
    })
}
fn accept(listener: &TcpListener, end: Instant) -> std::net::TcpStream {
    loop {
        match listener.accept() {
            Ok((stream, _)) => return stream,
            Err(error)
                if error.kind() == std::io::ErrorKind::WouldBlock && Instant::now() < end =>
            {
                std::thread::sleep(Duration::from_millis(5))
            }
            Err(error) => panic!("owned M backend accept: {error}"),
        }
    }
}
