//! Actual Rust front + sealed TypeScript FrontChannel qualification.
#![cfg(target_os = "linux")]
#[path = "support/http_client.rs"]
mod http_client;
#[path = "support/secure_stream.rs"]
mod secure_stream;
#[path = "support/shutdown.rs"]
mod shutdown;
#[path = "support/sse.rs"]
mod sse;
#[path = "support/streams.rs"]
mod streams;
mod support;
use support::*;
#[test]
#[ignore = "requires pinned Node and compiled sealed REVERIE_FRONT_CHILD_FIXTURE"]
fn actual_adapter_hello_multigrant_echo_peer_and_real_sigterm_shutdown() {
    runtime().block_on(qualify_adapter());
}
async fn qualify_adapter() {
    let running = Running::start(Mode::Front).await;
    assert_eq!(
        body(&request(&running, "GET", "/hello", &[]).await.unwrap()),
        b"hello"
    );
    let sent = (0..300 * 1024).map(|i| (i % 251) as u8).collect::<Vec<_>>();
    assert_eq!(
        body(&request(&running, "POST", "/echo", &sent).await.unwrap()),
        sent
    );
    let response = request(&running, "GET", "/peer", &[]).await.unwrap();
    let peer: serde_json::Value = serde_json::from_slice(body(&response)).unwrap();
    assert_eq!(peer["ip"], "127.0.0.1");
    assert_eq!(peer["localPort"], running.port);
    assert_eq!(peer["encrypted"], false);
    assert_eq!(peer["protocol"], "http");
    running.stop().await;
}
