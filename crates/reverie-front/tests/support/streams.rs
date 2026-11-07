//! E4/E6 use the same actual paired fixture and installed native executable.
use crate::support::*;
use std::time::Duration;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
};

const TOTAL: usize = 8 * 1024 * 1024;

#[test]
#[ignore = "requires pinned Node and both compiled sealed paired fixtures"]
fn keepalive_second_request_after_large_response_matches_direct_node() {
    runtime().block_on(async {
        for mode in [Mode::Direct, Mode::Front] {
            keepalive(mode).await;
        }
    });
}

async fn keepalive(mode: Mode) {
    let mut running = Running::start(mode).await;
    let mut socket = TcpStream::connect(("127.0.0.1", running.port))
        .await
        .unwrap();
    socket
        .write_all(
            format!(
                "GET /bytes?n={TOTAL} HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n"
            )
            .as_bytes(),
        )
        .await
        .unwrap();
    let first = tokio::time::timeout(Duration::from_secs(15), read_first(&mut socket))
        .await
        .unwrap();
    assert_eq!(body(&first).len(), TOTAL);
    assert!(body(&first).iter().all(|byte| *byte == b'x'));
    let head = &first[..first.len() - TOTAL];
    assert!(
        String::from_utf8_lossy(head)
            .to_ascii_lowercase()
            .contains(&format!("content-length: {TOTAL}\r\n"))
    );
    socket
        .write_all(b"GET /hello HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
        .await
        .unwrap();
    let mut second = Vec::new();
    tokio::time::timeout(Duration::from_secs(10), socket.read_to_end(&mut second))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        body(&second),
        b"hello",
        "{mode:?}: same connection must serve second request"
    );
    let finish = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let event = running.event().await;
            if event["event"] == "response_finish" && event["url"] == "/hello" {
                break;
            }
        }
    })
    .await;
    assert!(finish.is_ok());
    println!(
        "{}",
        serde_json::json!({"case":"E4","mode":format!("{mode:?}"),"first":body(&first).len(),"second":body(&second).len()})
    );
    running.stop().await;
}

async fn read_first(socket: &mut TcpStream) -> Vec<u8> {
    let mut received = Vec::new();
    let mut chunk = [0; 16384];
    loop {
        if let Some(head) = received.windows(4).position(|value| value == b"\r\n\r\n") {
            assert!(head < 16384, "fixed fixture header bound");
            if received.len() >= head + 4 + TOTAL {
                return received;
            }
        }
        let size = socket.read(&mut chunk).await.unwrap();
        assert_ne!(size, 0, "large response ended before Content-Length");
        received.extend_from_slice(&chunk[..size]);
        assert!(received.len() <= TOTAL + 16384);
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
}

#[test]
#[ignore = "requires pinned Node and both compiled sealed paired fixtures"]
fn request_write_half_close_preserves_full_response_and_clean_shutdown() {
    runtime().block_on(async {
        for mode in [Mode::Direct, Mode::Front] {
            half_close(mode).await;
        }
    });
}

async fn half_close(mode: Mode) {
    let mut running = Running::start(mode).await;
    let target = format!("/bytes?n={TOTAL}");
    let mut socket = open(&running, "GET", &target, &[]).await.unwrap();
    socket.shutdown().await.unwrap();
    let mut response = Vec::new();
    tokio::time::timeout(Duration::from_secs(15), socket.read_to_end(&mut response))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        body(&response).len(),
        TOTAL,
        "{mode:?}: response after SHUT_WR"
    );
    assert!(body(&response).iter().all(|byte| *byte == b'x'));
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let event = running.event().await;
            if event["event"] == "response_finish" && event["url"] == target {
                break;
            }
        }
    })
    .await
    .unwrap();
    println!(
        "{}",
        serde_json::json!({"case":"E6","mode":format!("{mode:?}"),"received":body(&response).len(),"finish":true})
    );
    running.stop().await;
}
