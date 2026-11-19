use reverie_speech::{Configuration, Whisper, serve};
use std::{fs, net::Ipv4Addr, path::PathBuf, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    time,
};

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        Self(nix::unistd::mkdtemp(&std::env::temp_dir().join("rv-speech-test-XXXXXX")).unwrap())
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

async fn request(address: std::net::SocketAddr, body: &str) -> String {
    let mut stream = TcpStream::connect(address).await.unwrap();
    stream.write_all(body.as_bytes()).await.unwrap();
    let mut output = String::new();
    time::timeout(Duration::from_secs(5), stream.read_to_string(&mut output))
        .await
        .unwrap()
        .unwrap();
    output
}

#[tokio::test]
async fn speech_transport_keeps_office_authority_and_bounds_uploads() {
    let root = Fixture::new();
    let assets = &root.0;
    fs::create_dir(assets.join("audio")).unwrap();
    let id = "1133557799bbddeeffccaa8866442200";
    fs::write(assets.join(format!("audio/{id}.wav")), b"legacy audio").unwrap();
    fs::write(assets.join("model.bin"), "fixture checkpoint").unwrap();
    fs::write(assets.join("en_US-amy-medium.onnx"), b"fixture model").unwrap();
    fs::write(
        assets.join("en_US-amy-medium.onnx.json"),
        r#"{"language":{"code":"en_US"},"audio":{"sample_rate":22050}}"#,
    )
    .unwrap();
    let engine = std::env::current_exe().unwrap();
    let whisper = Whisper::new(
        engine.clone(),
        engine.clone(),
        assets.join("model.bin"),
        assets.clone(),
        2,
    )
    .unwrap();
    let socket = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let address = socket.local_addr().unwrap();
    let endpoint = tokio::spawn(serve(
        socket,
        Configuration {
            whisper,
            piper: engine,
            models: assets.clone(),
            voice: "en_US-amy-medium".into(),
            scratch: assets.clone(),
            audio_ttl: Duration::from_secs(3600),
        },
    ));
    let health = request(
        address,
        "GET /health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
    )
    .await;
    assert!(health.contains(r#""stt":"ready""#) && health.contains(r#""tts":"ready""#));
    let voices = request(
        address,
        "GET /voices HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
    )
    .await;
    assert!(
        voices.contains(r#""name":"en_US-amy-medium""#) && voices.contains(r#""language":"en_US""#)
    );
    let audio = request(
        address,
        &format!("GET /audio/{id}.wav HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"),
    )
    .await;
    assert!(audio.contains("content-type: audio/wav") && audio.ends_with("legacy audio"));
    let oversize = request(address, "POST /stt HTTP/1.1\r\nHost: localhost\r\nContent-Type: audio/webm\r\nContent-Length: 10485761\r\nConnection: close\r\n\r\n").await;
    assert!(oversize.starts_with("HTTP/1.1 413"));
    let turn = request(
        address,
        "POST /turn HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
    )
    .await;
    assert!(turn.starts_with("HTTP/1.1 404"));
    endpoint.abort();
    assert!(endpoint.await.unwrap_err().is_cancelled());
}
