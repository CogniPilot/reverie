use super::*;
use std::{
    sync::atomic::{AtomicUsize, Ordering},
    task::{Wake, Waker},
};
#[derive(Default)]
struct Counter(AtomicUsize);
impl Wake for Counter {
    fn wake(self: Arc<Self>) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}
fn ready(waiter: &mut ScratchWait, waker: &Waker) -> OwnedSemaphorePermit {
    match waiter.poll(&mut Context::from_waker(waker)) {
        Poll::Ready(Ok(permit)) => permit,
        _ => panic!("owned parser slot should be ready"),
    }
}
fn pending(waiter: &mut ScratchWait, waker: &Waker) {
    assert!(waiter.poll(&mut Context::from_waker(waker)).is_pending());
}
#[test]
fn reserved_parser_slice_progresses_with_no_unissued_payload_bytes_and_is_fifo() {
    let pool = BytePool::new(SCRATCH_BYTES as usize + 64).unwrap();
    let scratch = SharedScratch::reserve(&pool).unwrap();
    let payload = pool.reserve(NonZeroU32::new(64).unwrap()).unwrap();
    assert_eq!(pool.available(), 0);
    let counter = Arc::new(Counter::default());
    let waker = Waker::from(counter.clone());
    let mut first = scratch.waiter();
    let mut second = scratch.waiter();
    let mut third = scratch.waiter();
    let held = ready(&mut first, &waker);
    pending(&mut second, &waker);
    pending(&mut third, &waker);
    drop(held);
    assert!(counter.0.load(Ordering::SeqCst) > 0);
    pending(&mut third, &waker); // A later reader cannot steal an earlier slot.
    let next = ready(&mut second, &waker);
    pending(&mut third, &waker);
    drop(next);
    drop(ready(&mut third, &waker));
    assert_eq!(pool.available(), 0);
    drop((first, second, third, scratch));
    assert_eq!(pool.issued(), 64);
    drop(payload);
    assert_eq!(pool.issued(), 0);
}
#[test]
fn cancelling_a_queued_operation_releases_its_place_without_stranding_the_next_waiter() {
    for assigned in [false, true] {
        let pool = BytePool::new(SCRATCH_BYTES as usize).unwrap();
        let scratch = SharedScratch::reserve(&pool).unwrap();
        let waker = Waker::from(Arc::new(Counter::default()));
        let mut first = scratch.waiter();
        let mut cancelled = scratch.waiter();
        let mut remaining = scratch.waiter();
        let mut held = Some(ready(&mut first, &waker));
        pending(&mut cancelled, &waker);
        pending(&mut remaining, &waker);
        if assigned {
            drop(held.take());
        }
        drop(cancelled);
        drop(held);
        drop(ready(&mut remaining, &waker));
        drop((first, remaining, scratch));
        assert_eq!(pool.issued(), 0);
    }
}
