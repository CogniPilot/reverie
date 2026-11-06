use super::*;
use crate::budget::BytePool;
use reverie_contracts::route_frames_v2::{AbortReason, Signal};
use std::num::{NonZeroU32, NonZeroU64};

fn packet(pool: &BytePool, bytes: Vec<u8>) -> StreamPacket {
    let lease = pool
        .reserve(NonZeroU32::new(bytes.len() as u32).unwrap())
        .unwrap();
    StreamPacket::Data(ChargedData::new(bytes, lease).unwrap())
}
fn outbox(limit: usize) -> Outbox {
    Outbox::new(NonZeroU64::new(1).unwrap(), limit)
}
#[test]
fn saturated_streams_preserve_end_order_and_control_progress() {
    let pool = BytePool::new(2 * MAX_DATA_BYTES).unwrap();
    let mut out = outbox(1024);
    out.stream(1, packet(&pool, vec![1; MAX_DATA_BYTES]))
        .unwrap();
    out.stream(1, StreamPacket::End).unwrap();
    out.stream(2, packet(&pool, vec![2; MAX_DATA_BYTES]))
        .unwrap();
    assert_eq!(pool.available(), 0);
    out.control(2, Body::Credit(10)).unwrap();
    out.control(
        0,
        Body::Shutdown {
            signal: Signal::Term,
        },
    )
    .unwrap();
    assert_eq!(out.pop().unwrap().frame.body, Body::Credit(10));
    assert!(matches!(
        out.pop().unwrap().frame.body,
        Body::Shutdown { .. }
    ));
    let writing = out.pop().unwrap();
    assert_eq!(writing.frame.id, 1);
    assert_eq!(pool.available(), 0, "issued until actual write completes");
    assert_eq!(out.pop().unwrap().frame.id, 2, "round robin");
    assert_eq!(out.pop().unwrap().frame.body, Body::End);
    drop(writing);
    assert_eq!(pool.issued(), 0);
}
#[test]
fn abort_discards_queued_bytes_and_end_but_cannot_retract_inflight_bytes() {
    let pool = BytePool::new(2 * MAX_DATA_BYTES).unwrap();
    let mut out = outbox(1024);
    out.stream(1, packet(&pool, vec![1; MAX_DATA_BYTES]))
        .unwrap();
    out.stream(1, packet(&pool, vec![2; MAX_DATA_BYTES]))
        .unwrap();
    out.stream(1, StreamPacket::End).unwrap();
    let inflight = out.pop().unwrap();
    out.control(1, Body::Abort(AbortReason::Destroy)).unwrap();
    assert_eq!(pool.issued(), MAX_DATA_BYTES);
    assert!(matches!(out.pop().unwrap().frame.body, Body::Abort(_)));
    assert!(out.pop().is_none());
    drop(inflight);
    assert_eq!(pool.issued(), 0);
}
#[test]
fn tiny_fragments_are_coalesced_and_credit_has_one_bounded_pending_frame() {
    let pool = BytePool::new(MAX_DATA_BYTES + 1).unwrap();
    let mut out = outbox(26);
    for _ in 0..1000 {
        out.stream(1, packet(&pool, vec![7])).unwrap();
        out.control(1, Body::Credit(1)).unwrap();
    }
    assert_eq!(out.control_bytes(), 26);
    assert!(matches!(
        out.control(2, Body::Credit(1)),
        Err(QueueError::ControlFull)
    ));
    assert_eq!(out.pop().unwrap().frame.body, Body::Credit(1000));
    assert_eq!(out.pop().unwrap().frame.body, Body::Data(vec![7; 1000]));
    assert!(out.pop().is_none());
    assert_eq!(pool.issued(), 0);
}
#[test]
fn coalescing_splits_at_wire_bound_and_graceful_end_is_a_barrier() {
    let pool = BytePool::new(MAX_DATA_BYTES + 4).unwrap();
    let mut queue = StreamQueue::default();
    queue
        .push(packet(&pool, vec![1; MAX_DATA_BYTES - 1]))
        .unwrap();
    queue.push(packet(&pool, vec![2; 4])).unwrap();
    queue.push(StreamPacket::End).unwrap();
    assert!(matches!(
        queue.push(packet(&pool, vec![3])),
        Err(QueueError::AfterEnd)
    ));
    let Some(StreamPacket::Data(first)) = queue.pop() else {
        panic!("first data")
    };
    assert_eq!(first.bytes().len(), MAX_DATA_BYTES);
    assert_eq!(first.bytes()[MAX_DATA_BYTES - 1], 2);
    let Some(StreamPacket::Data(second)) = queue.pop() else {
        panic!("remaining data")
    };
    assert_eq!(second.bytes(), [2, 2, 2]);
    assert!(matches!(queue.pop(), Some(StreamPacket::End)));
}
#[test]
fn tiny_charged_payloads_do_not_retain_large_uncharged_allocations() {
    let pool = BytePool::new(MAX_DATA_BYTES + 5).unwrap();
    let mut bytes = Vec::with_capacity(MAX_DATA_BYTES);
    bytes.push(9);
    let lease = pool.reserve(NonZeroU32::new(1).unwrap()).unwrap();
    let small = ChargedData::new(bytes, lease).unwrap();
    assert_eq!(small.bytes.capacity(), 1);
    let mut queue = StreamQueue::default();
    queue
        .push(packet(&pool, vec![1; MAX_DATA_BYTES - 2]))
        .unwrap();
    queue.push(packet(&pool, vec![2; 4])).unwrap();
    let Some(StreamPacket::Data(first)) = queue.pop() else {
        panic!("full packet")
    };
    let Some(StreamPacket::Data(remainder)) = queue.pop() else {
        panic!("remainder")
    };
    assert_eq!(first.bytes.capacity(), MAX_DATA_BYTES);
    assert_eq!(remainder.bytes.capacity(), 2);
}
