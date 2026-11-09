use super::*;
use crate::office::tests::Fixture;
use std::{
    io::{Read, Write},
    net::TcpListener,
    os::unix::net::UnixListener,
    thread,
};
const SID: &str = "11111111-1111-4111-8111-111111111111";
const RID: &str = "33333333-3333-4333-8333-333333333333";
const MID: &str = "44444444-4444-4444-8444-444444444444";
const FID: &str = "55555555-5555-4555-8555-555555555555";
fn scope() -> ImageScope {
    reverie_contracts::chat_images::decode_scope(format!("{{\"version\":1,\"sessionId\":\"{SID}\",\"roomId\":\"{RID}\",\"messageId\":\"{MID}\",\"generation\":\"{}\",\"fileIds\":[\"{FID}\"]}}", "a".repeat(64)).as_bytes()).unwrap()
}
fn request(stream: &mut impl Read) -> String {
    let mut bytes = Vec::new();
    while !bytes.ends_with(b"\r\n\r\n") {
        let mut byte = [0];
        stream.read_exact(&mut byte).unwrap();
        bytes.push(byte[0]);
    }
    String::from_utf8(bytes).unwrap()
}
fn accept(
    listener: &TcpListener,
    end: Instant,
) -> std::result::Result<std::net::TcpStream, String> {
    loop {
        match listener.accept() {
            Ok((stream, _)) => return Ok(stream),
            Err(error)
                if error.kind() == std::io::ErrorKind::WouldBlock && Instant::now() < end =>
            {
                thread::sleep(Duration::from_millis(5))
            }
            Err(error) => return Err(format!("fixture accept: {error}")),
        }
    }
}
#[test]
fn actual_phone_performs_three_fixed_gets_with_host_session_and_membership_recheck() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let fixture = Fixture::new(listener.local_addr().unwrap());
    let phone = fixture.bind("image");
    let reader = fixture
        .service
        .image_reader(&phone, &fixture.runtime)
        .unwrap();
    let message = format!(
        "{{\"success\":true,\"data\":{{\"message\":{{\"id\":\"{MID}\",\"attachments\":[{{\"id\":\"{FID}\",\"type\":\"image/png\"}}]}}}}}}"
    );
    let bytes = b"\x89PNG\r\n\x1a\nowned";
    let server = thread::spawn(move || {
        let end = Instant::now() + Duration::from_secs(15);
        let mut requests = Vec::new();
        for index in 0..3 {
            let mut stream = accept(&listener, end)
                .map_err(|error| format!("{error}; requests={requests:?}"))?;
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let request = request(&mut stream).to_ascii_lowercase();
            let target = if index == 1 {
                format!("/api/v1/chatrooms/{RID}/files/{FID}")
            } else {
                format!("/api/v1/chatrooms/{RID}/messages/{MID}")
            };
            requests.push((request, target));
            let (body, mime) = if index == 1 {
                (bytes.as_slice(), "image/png")
            } else {
                (message.as_bytes(), "application/json")
            };
            write!(stream, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nContent-Type: {mime}\r\nConnection: close\r\n\r\n", body.len()).unwrap();
            stream.write_all(body).unwrap();
        }
        Ok::<_, String>(requests)
    });
    let scope = scope();
    let output = reader.fetch(&fixture.runtime, &scope, &scope.files()[0]);
    let requests = server.join().unwrap();
    assert!(
        output.is_ok(),
        "actual fetch: {output:?}; requests: {requests:?}"
    );
    for (request, target) in requests.unwrap() {
        assert!(request.contains(&format!("x-reverie-parent-session: {SID}")));
        assert!(request.contains("authorization: basic "));
        assert!(request.starts_with(&format!("get {target} http/1.1")));
    }
    assert_eq!(output.unwrap(), bytes);
    phone.request_close();
    assert!(reader.identity(&fixture.runtime).is_err());
}
#[test]
fn raw_header_observation_preserves_duplicates_whitespace_and_length_limits() {
    for head in [
        b"HTTP/1.1 200 OK\r\nContent-Length: 8\r\nContent-Length: 8\r\n\r\n".as_slice(),
        b"HTTP/1.1 200 OK\r\nContent-Length: 8 \r\n\r\n",
        b"HTTP/1.1 200 OK\r\nContent-Length: 8\r\nTransfer-Encoding: chunked\r\n\r\n",
        b"HTTP/1.1 200 OK\r\nContent-Length: 8\r\nContent-Encoding: gzip\r\n\r\n",
    ] {
        let mut headers = raw_headers::Headers::default();
        for byte in head {
            headers.observe(&[*byte]).unwrap();
        }
        assert!(headers.expected(8).is_err());
    }
    let mut headers = raw_headers::Headers::default();
    headers
        .observe(b"HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 8\r\n\r\n")
        .unwrap();
    assert_eq!(headers.expected(8).unwrap(), 8);
}
#[test]
fn actual_uds_duplicate_lengths_refuse_without_waiting_for_body() {
    let fixture = Fixture::new("127.0.0.1:9".parse().unwrap());
    let path = fixture.root.join("raw");
    let listener = UnixListener::bind(&path).unwrap();
    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        request(&mut stream);
        stream
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 8\r\nContent-Length: 8\r\n\r\n")
            .unwrap();
        let mut byte = [0];
        assert_eq!(stream.read(&mut byte).unwrap(), 0);
    });
    let end = Instant::now() + Duration::from_secs(2);
    let mut stream = io::connect(&path, &fixture.runtime, end).unwrap();
    let executor = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let result = executor.block_on(exchange::read(
        &mut stream,
        &fixture.runtime,
        "/fixed",
        8,
        end,
    ));
    crate::native::owned_process::close(stream.into()).unwrap();
    server.join().unwrap();
    assert_eq!(result.err().unwrap().code(), "access_or_body_refused");
}
