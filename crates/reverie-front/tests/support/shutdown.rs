//! Compare identical Fastify routes/triggers on direct Node and the Rust front.
use crate::support::*;
use std::time::Duration;
use tokio::{io::AsyncReadExt, net::TcpStream};
#[test]
#[ignore = "requires pinned Node and both compiled sealed paired fixtures"]
fn slow_client_response_finished_before_sigterm_matches_direct_delivery() {
    runtime().block_on(async {
        for mode in [Mode::Direct, Mode::Front] {
            after_finish(mode).await;
        }
    });
}
async fn after_finish(mode: Mode) {
    let total = 8 * 1024 * 1024;
    let mut running = Running::start(mode).await;
    let target = format!("/bytes?n={total}");
    let mut socket = open(&running, "GET", &target, &[]).await.unwrap();
    let mut received = Vec::new();
    tokio::time::timeout(
        Duration::from_secs(15),
        read_until_finish(&mut running, &mut socket, &mut received, &target),
    )
    .await
    .unwrap();
    let at_signal = received.len();
    assert!(
        at_signal < total,
        "fixture must still have unread response bytes"
    );
    running.terminate();
    tokio::time::sleep(Duration::from_millis(300)).await;
    let clean = tokio::time::timeout(Duration::from_secs(15), socket.read_to_end(&mut received))
        .await
        .unwrap()
        .is_ok();
    let status = running.stopped().await;
    let payload = body(&received);
    println!(
        "{}",
        serde_json::json!({"mode":format!("{mode:?}"),"trigger":"response_finish","total":total,"at_signal":at_signal,"received":payload.len(),"clean":clean,"status":status,"events":running.history})
    );
    assert!(clean);
    assert_eq!(status, 0);
    assert_eq!(
        payload.len(),
        total,
        "{mode:?} lost bytes after response_finish"
    );
    assert!(payload.iter().all(|&byte| byte == b'x'));
}
async fn read_until_finish(
    running: &mut Running,
    socket: &mut TcpStream,
    received: &mut Vec<u8>,
    target: &str,
) {
    let mut chunk = [0; 16384];
    loop {
        tokio::select! {
            biased;
            event = running.event() => {
                if event["event"]=="response_finish" && event["url"]==target { return; }
            }
            read = socket.read(&mut chunk) => {
                let size = read.unwrap();
                assert_ne!(size,0,"response EOF before fixture finish event");
                received.extend_from_slice(&chunk[..size]);
            }
        }
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
}
#[test]
#[ignore = "requires pinned Node and both compiled sealed paired fixtures"]
fn slow_client_shutdown_before_finish_retains_direct_truncation_baseline() {
    runtime().block_on(async {
        for mode in [Mode::Direct, Mode::Front] {
            before_finish(mode).await;
        }
    });
}
async fn before_finish(mode: Mode) {
    let total = 64 * 1024 * 1024;
    let mut running = Running::start(mode).await;
    let target = format!("/bytes?n={total}");
    let mut socket = open(&running, "GET", &target, &[]).await.unwrap();
    let mut received = Vec::new();
    let mut chunk = [0; 256];
    while !received.windows(4).any(|b| b == b"\r\n\r\n") {
        let size = tokio::time::timeout(Duration::from_secs(10), socket.read(&mut chunk))
            .await
            .unwrap()
            .unwrap();
        assert_ne!(size, 0);
        received.extend_from_slice(&chunk[..size]);
    }
    tokio::time::sleep(Duration::from_millis(500)).await;
    running.available_events();
    assert!(
        !running
            .history
            .iter()
            .any(|e| e["event"] == "response_finish" && e["url"] == target)
    );
    let at_signal = received.len();
    running.terminate();
    let clean = tokio::time::timeout(Duration::from_secs(15), socket.read_to_end(&mut received))
        .await
        .unwrap()
        .is_ok();
    let status = running.stopped().await;
    let payload = body(&received);
    println!(
        "{}",
        serde_json::json!({"mode":format!("{mode:?}"),"trigger":"headers_before_finish","total":total,"at_signal":at_signal,"received":payload.len(),"clean":clean,"status":status,"events":running.history})
    );
    assert_eq!(status, 0);
    assert!(
        payload.len() < total,
        "direct baseline distinguishes queued end from finish"
    );
    assert!(payload.iter().all(|&byte| byte == b'x'));
}
