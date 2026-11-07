//! Real backpressure/held socket with actual first-stop expiry. No result or
//! clock substitution; every test finalizes/joins its actual owned thread.
use super::*;
use std::sync::mpsc;
fn isolated(name: &str) -> bool {
    crate::test_process::isolate_case(&format!(
        "worker_reports::tests::resume_channel::budgets::{name}"
    ))
}
fn observed(flag: &AtomicBool) {
    let end = end();
    while !flag.load(Ordering::Acquire) {
        assert!(Instant::now() < end, "actual owned channel wait");
        std::thread::sleep(Duration::from_millis(1));
    }
}
fn fill(record: &Record) -> usize {
    use std::os::fd::AsRawFd;
    let mut total = 0;
    let slot = record.terminal_stream().unwrap();
    let stream = slot.as_ref().unwrap();
    nix::sys::socket::setsockopt(stream, nix::sys::socket::sockopt::SndBuf, &4096usize).unwrap();
    let end = end();
    loop {
        assert!(Instant::now() < end && total < 262144);
        let flags =
            nix::sys::socket::MsgFlags::MSG_DONTWAIT | nix::sys::socket::MsgFlags::MSG_NOSIGNAL;
        match nix::sys::socket::send(stream.as_raw_fd(), b"x", flags) {
            Ok(1) => total += 1,
            Err(nix::errno::Errno::EAGAIN) => return total,
            result => panic!("fixed fixture socket fill: {result:?}"),
        }
    }
}
#[test]
fn greeting_preserves_original_ten_second_send_budget_after_real_backpressure() {
    if isolated("greeting_preserves_original_ten_second_send_budget_after_real_backpressure") {
        return;
    }
    let fixture = Fixture::new();
    let service = Arc::new(fixture.service());
    let (mut client, server) = fixture.sockets();
    send(
        &mut client,
        b'Q',
        br#"{"purpose":"resource-replacement-v1","version":1}"#,
    );
    let mut channel = accepted(&fixture, &service, server)
        .retain_resource_website_channel(&fixture.runtime)
        .ok()
        .unwrap();
    channel.pin_peer().unwrap();
    let record = service.records.lock().unwrap()[0].clone();
    let bytes = fill(&record);
    let entered = Arc::new(AtomicBool::new(false));
    let waiting = entered.clone();
    let (sent, received) = mpsc::channel();
    let thread = std::thread::spawn(move || {
        super::super::super::resume::test_hooks::bind_send(waiting);
        let result = channel.greet(Instant::now() + Duration::from_secs(10));
        sent.send((channel, result)).unwrap();
    });
    observed(&entered);
    std::thread::sleep(Duration::from_millis(2100));
    let mut raw = vec![0; bytes];
    client.read_exact(&mut raw).unwrap();
    let (mut channel, greeted) = received.recv_timeout(Duration::from_secs(3)).unwrap();
    let mut greeting = [0; 15];
    let read = if greeted.is_ok() {
        client.read_exact(&mut greeting)
    } else {
        Ok(())
    };
    let closed = channel.close_for_worker();
    thread.join().unwrap();
    assert!(
        greeted.is_ok(),
        "actual greeting failed after original2s cap: {greeted:?}"
    );
    assert!(read.is_ok());
    assert_eq!(&greeting, b"RESOURCE_READY\n");
    assert!(closed.is_ok());
    service.close(end()).unwrap();
}
#[test]
fn late_close_settles_same_record_after_actual_preconsumption_lock_timeout() {
    if isolated("late_close_settles_same_record_after_actual_preconsumption_lock_timeout") {
        return;
    }
    let fixture = Fixture::new();
    let service = Arc::new(fixture.service());
    let (_client, mut channel) = channel(&fixture, &service);
    let record = service.records.lock().unwrap()[0].clone();
    let held = record.terminal_stream().unwrap();
    let entered = Arc::new(AtomicBool::new(false));
    let waiting = entered.clone();
    let (sent, received) = mpsc::channel();
    let thread = std::thread::spawn(move || {
        super::super::super::resume::test_hooks::bind_lock(waiting);
        let result = channel.close_for_worker();
        sent.send((channel, result)).unwrap();
    });
    observed(&entered);
    fixture
        .runtime
        .installed_engine()
        .expire_stop_for_owned_test();
    let (mut channel, first) = received.recv_timeout(Duration::from_secs(2)).unwrap();
    thread.join().unwrap();
    let count_before = service.records.lock().unwrap().len();
    drop(held);
    let later = channel.close_for_worker();
    let count_after = service.records.lock().unwrap().len();
    assert!(first.is_err());
    assert_eq!(
        count_before, 1,
        "same actual record remains counted while held"
    );
    assert!(
        later.is_ok(),
        "pure wait refusal cannot erase later checked closure: {later:?}"
    );
    assert_eq!(count_after, 0);
    service.close(end()).unwrap();
}
