//! E5: actual client backpressure, maintained chunk decoding and exact SSE bytes.
use crate::{
    http_client::{Response, append, finished},
    support::*,
};
use std::time::Duration;

const COUNT: usize = 64;
const SIZE: usize = 256 * 1024;

#[test]
#[ignore = "requires pinned Node, both compiled sealed paired fixtures and explicit native executable"]
fn stalled_sse_reader_resumes_and_receives_every_decoded_event_in_order() {
    runtime().block_on(async {
        for mode in [Mode::Direct, Mode::Front] {
            qualify(mode).await;
        }
    });
}
async fn qualify(mode: Mode) {
    let mut running = Running::start(mode).await;
    let target = format!("/sse?n={COUNT}&size={SIZE}");
    let mut response = Response::get(&running, &target, None).await;
    let stalled = tokio::time::timeout(Duration::from_secs(10), stalled(&mut running))
        .await
        .unwrap();
    assert!(
        stalled > 0 && stalled < COUNT,
        "{mode:?}: reader must stall producer"
    );
    assert!(
        running
            .history
            .iter()
            .any(|e| e["event"] == "sse_write" && e["ok"] == false)
    );
    assert!(!running.history.iter().any(|e| finished(e, &target)));
    let mut received = Vec::new();
    let total = COUNT * (SIZE + 8);
    tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            tokio::select! {
                _ = running.event() => {},
                chunk = response.next() => {
                    let Some(chunk) = chunk else { break; };
                    append(&mut received, &chunk, total);
                }
            }
        }
        while !running.history.iter().any(|e| finished(e, &target)) {
            running.event().await;
        }
    })
    .await
    .unwrap();
    response.settled().await;
    assert_eq!(received.len(), total, "{mode:?}: decoded SSE length");
    for event in received.chunks_exact(SIZE + 8) {
        assert_eq!(&event[..6], b"data: ");
        assert!(event[6..SIZE + 6].iter().all(|byte| *byte == b'x'));
        assert_eq!(&event[SIZE + 6..], b"\n\n");
    }
    let writes: Vec<_> = running
        .history
        .iter()
        .filter(|e| e["event"] == "sse_write")
        .collect();
    assert_eq!(writes.len(), COUNT);
    for (seq, event) in writes.iter().enumerate() {
        assert_eq!(event["seq"], seq);
        assert_eq!(event["bytes"], SIZE + 8);
    }
    let blocked: Vec<_> = writes
        .iter()
        .filter(|e| e["ok"] == false)
        .map(|e| e["seq"].clone())
        .collect();
    let drained: Vec<_> = running
        .history
        .iter()
        .filter(|e| e["event"] == "sse_drain")
        .map(|e| e["seq"].clone())
        .collect();
    assert_eq!(drained, blocked, "each backpressured write must drain");
    check_event_order(&running);
    println!(
        "{}",
        serde_json::json!({"case":"E5","mode":format!("{mode:?}"),"stalled_writes":stalled,"writes":writes.len(),"drains":drained.len(),"decoded":received.len()})
    );
    running.stop().await;
}

async fn stalled(running: &mut Running) -> usize {
    loop {
        let before = running
            .history
            .iter()
            .filter(|e| e["event"] == "sse_write")
            .count();
        let pause = tokio::time::sleep(Duration::from_millis(300));
        tokio::pin!(pause);
        loop {
            tokio::select! {
                () = &mut pause => break,
                _ = running.event() => {}
            }
        }
        running.available_events();
        let writes: Vec<_> = running
            .history
            .iter()
            .filter(|e| e["event"] == "sse_write")
            .collect();
        if writes.len() != before {
            continue;
        }
        if let Some(last) = writes.last() {
            let drained = running
                .history
                .iter()
                .any(|e| e["event"] == "sse_drain" && e["seq"] == last["seq"]);
            if last["ok"] == false && !drained {
                return writes.len();
            }
        }
    }
}

fn check_event_order(running: &Running) {
    let mut pending = None;
    let mut written = 0;
    for event in &running.history {
        if event["event"] == "sse_write" {
            assert!(
                pending.is_none(),
                "next write cannot precede required drain"
            );
            assert_eq!(event["seq"], written);
            written += 1;
            if event["ok"] == false {
                pending = Some(event["seq"].clone());
            }
        } else if event["event"] == "sse_drain" {
            assert_eq!(pending.take(), Some(event["seq"].clone()));
        }
    }
    assert_eq!(written, COUNT);
    assert!(pending.is_none());
}
