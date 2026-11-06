//! E3: verified TLS uses the same material and real finish/shutdown trigger.
use crate::{
    http_client::{Response, append, finished},
    support::*,
};
use std::{path::PathBuf, time::Duration};

#[test]
#[ignore = "requires pinned Node, both compiled paired fixtures and an explicit native executable"]
fn verified_tls_shutdown_after_finish_matches_direct_node_delivery() {
    runtime().block_on(async {
        for mode in [Mode::Direct, Mode::Front] {
            qualify(mode).await;
        }
    });
}
async fn qualify(mode: Mode) {
    let material = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/tls/fixtures");
    let cert = material.join("localhost.crt");
    let mut running = Running::start_tls(mode, &cert, &material.join("localhost.key")).await;
    peer(&running, &cert).await;
    let total = 8 * 1024 * 1024;
    let target = format!("/bytes?n={total}");
    let mut response = Response::get(&running, &target, Some(&cert)).await;
    let mut received = Vec::new();
    tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            tokio::select! {
                biased;
                event = running.event() => { if finished(&event, &target) { break; } }
                chunk = response.next() => {
                    append(&mut received, &chunk.expect("TLS body before finish"), total);
                }
            }
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    })
    .await
    .unwrap();
    let at_signal = received.len();
    assert!(
        at_signal < total,
        "actual TLS client still has unread bytes"
    );
    running.terminate();
    tokio::time::sleep(Duration::from_millis(300)).await;
    tokio::time::timeout(Duration::from_secs(20), async {
        while let Some(chunk) = response.next().await {
            append(&mut received, &chunk, total);
        }
    })
    .await
    .unwrap();
    response.settled().await;
    let status = running.stopped().await;
    assert_eq!(
        received.len(),
        total,
        "{mode:?}: complete verified TLS response"
    );
    assert!(received.iter().all(|byte| *byte == b'x'));
    assert_eq!(status, 0);
    println!(
        "{}",
        serde_json::json!({"case":"E3","mode":format!("{mode:?}"),"verified":true,"at_signal":at_signal,"received":received.len(),"status":status,"events":running.history})
    );
}

async fn peer(running: &Running, cert: &std::path::Path) {
    let mut response = Response::get(running, "/peer", Some(cert)).await;
    let mut received = Vec::new();
    tokio::time::timeout(Duration::from_secs(10), async {
        while let Some(chunk) = response.next().await {
            append(&mut received, &chunk, 4096);
        }
    })
    .await
    .unwrap();
    response.settled().await;
    let value: serde_json::Value = serde_json::from_slice(&received).unwrap();
    assert_eq!(value["ip"], "127.0.0.1");
    assert_eq!(value["localPort"], running.port);
    assert_eq!(value["encrypted"], true);
    assert_eq!(value["protocol"], "https");
}

#[test]
#[ignore = "requires pinned Node, both compiled paired fixtures and an explicit native executable"]
fn verified_tls_shutdown_before_finish_preserves_direct_truncation_baseline() {
    runtime().block_on(async {
        for mode in [Mode::Direct, Mode::Front] {
            before_finish(mode).await;
        }
    });
}

async fn before_finish(mode: Mode) {
    let material = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/tls/fixtures");
    let cert = material.join("localhost.crt");
    let mut running = Running::start_tls(mode, &cert, &material.join("localhost.key")).await;
    let total = 64 * 1024 * 1024;
    let target = format!("/bytes?n={total}");
    let mut response = Response::get(&running, &target, Some(&cert)).await;
    // No application body consumption before shutdown; the HTTP driver's
    // bounded read-ahead cannot absorb this response or manufacture finish.
    tokio::time::sleep(Duration::from_millis(500)).await;
    running.available_events();
    assert!(!running.history.iter().any(|e| finished(e, &target)));
    running.terminate();
    let mut received = Vec::new();
    let framing_clean = tokio::time::timeout(Duration::from_secs(20), async {
        while let Some(chunk) = response.next_result().await {
            match chunk {
                Ok(chunk) => append(&mut received, &chunk, total),
                Err(_) => return false,
            }
        }
        true
    })
    .await
    .unwrap();
    let driver_clean = response.settled_result().await.is_ok();
    let status = running.stopped().await;
    assert!(
        received.len() < total,
        "{mode:?}: before-finish negative control"
    );
    assert!(received.iter().all(|byte| *byte == b'x'));
    assert!(!running.history.iter().any(|e| finished(e, &target)));
    assert_eq!(status, 0);
    println!(
        "{}",
        serde_json::json!({"case":"E3-before-finish","mode":format!("{mode:?}"),"verified":true,"received":received.len(),"total":total,"framing_clean":framing_clean,"driver_clean":driver_clean,"status":status,"events":running.history})
    );
}
