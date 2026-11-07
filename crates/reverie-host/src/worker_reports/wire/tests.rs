use super::*;
use crate::worker_reports::tests::Fixture;
use std::io::Write;
#[test]
fn one_sendall_deadline_includes_header_payload_and_actual_partial_write_progress() {
    // Encode/setup precede the stopwatch. Both ends are already accepted,
    // exclusively owned native sockets before the operation budget begins.
    let payload = vec![b'a'; MAX_FRAME];
    let fixture = Fixture::new();
    let service = fixture.service();
    let (mut client, mut server) = fixture.sockets();
    nix::sys::socket::setsockopt(&server, nix::sys::socket::sockopt::SndBuf, &1024usize).unwrap();
    std::thread::scope(|scope| {
        let (started, observing) = std::sync::mpsc::sync_channel(1);
        let task = scope.spawn(move || {
            let original_flags = nix::fcntl::fcntl(&server, nix::fcntl::FcntlArg::F_GETFL).unwrap();
            let start = Instant::now();
            let end = start + Duration::from_millis(300);
            started.send(end).unwrap();
            let result = send_until(&service, &mut server, b'J', &payload, end);
            let elapsed = start.elapsed();
            assert_eq!(
                nix::fcntl::fcntl(&server, nix::fcntl::FcntlArg::F_GETFL).unwrap(),
                original_flags,
                "per-call nonblocking must leave OFD flags unchanged"
            );
            let result = crate::worker_reports::error::finalized(
                result,
                crate::worker_reports::record::close(server),
            );
            (result, elapsed)
        });
        let _original_end = observing.recv_timeout(Duration::from_secs(2)).unwrap();
        let mut received = 0;
        // Continued benign progress must not renew the original budget. A
        // per-write300ms reset remains active through this >1s reader schedule.
        for _ in 0..8 {
            std::thread::sleep(Duration::from_millis(200));
            let mut chunk = [0; 65536];
            match client.read(&mut chunk) {
                Ok(0) => break,
                Ok(count) => received += count,
                Err(error) => panic!("owned writer must close or progress: {error}"),
            }
        }
        let (result, elapsed) = task.join().unwrap();
        assert!(
            matches!(result, Err(WorkerReportError::Io(error)) if matches!(error.kind(), std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock))
        );
        assert!(received > HEADER_BYTES && received < MAX_FRAME + HEADER_BYTES);
        assert!(
            elapsed < Duration::from_secs(1),
            "same300ms total send budget, not per-chunk renewal: {elapsed:?}"
        );
    });
}
static INTERRUPTED: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
thread_local! { static RECEIVE_READY:std::cell::RefCell<Option<std::sync::Arc<std::sync::atomic::AtomicBool>>> = const { std::cell::RefCell::new(None) }; }
pub(super) fn receive_attempt_started() {
    RECEIVE_READY.with(|slot| {
        if let Some(flag) = slot.borrow().as_ref() {
            flag.store(true, std::sync::atomic::Ordering::Release);
        }
    });
}
struct ReadyReset;
impl Drop for ReadyReset {
    fn drop(&mut self) {
        RECEIVE_READY.with(|slot| *slot.borrow_mut() = None);
    }
}
pub(super) fn received_interrupt() {
    INTERRUPTED.fetch_add(1, std::sync::atomic::Ordering::AcqRel);
}
#[test]
fn original_recv_deadline_survives_actual_signals_without_byte_progress() {
    let (_, module) = module_path!().split_once("::").unwrap();
    let name =
        format!("{module}::original_recv_deadline_survives_actual_signals_without_byte_progress");
    if crate::test_process::isolate_case(&name) {
        return;
    }
    let fixture = Fixture::new();
    let service = fixture.service();
    let (_client, mut server) = fixture.sockets();
    let mut buffer = [0];
    INTERRUPTED.store(0, std::sync::atomic::Ordering::Release);
    // The actual production10s receive policy is used. A bad fresh10s retry
    // survives the bounded13s sender and finishes only after roughly23s.
    let ((result, elapsed), signals) = crate::native::interrupted_test::interrupt_current(|| {
        let start = Instant::now();
        let result = read(&service, &mut server, &mut buffer);
        (result, start.elapsed())
    })
    .unwrap();
    assert!(
        signals >= 5 && INTERRUPTED.load(std::sync::atomic::Ordering::Acquire) >= 5,
        "real native Interrupted outcomes were observed"
    );
    assert!(
        matches!(result, Err(WorkerReportError::Io(error)) if matches!(error.kind(), std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock))
    );
    assert!(
        elapsed >= Duration::from_secs(9) && elapsed < Duration::from_secs(12),
        "original10s attempt was not renewed by EINTR: {elapsed:?}"
    );
}
#[test]
fn ordinary_partial_receive_progress_gets_a_new_attempt_without_a_total_frame_deadline() {
    let fixture = Fixture::new();
    let service = fixture.service();
    let (mut client, mut server) = fixture.sockets();
    std::thread::scope(|scope| {
        let ready = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        RECEIVE_READY.with(|slot| *slot.borrow_mut() = Some(ready.clone()));
        let _reset = ReadyReset;
        let sender_ready = ready.clone();
        let task = scope.spawn(move || {
            let until = Instant::now() + Duration::from_secs(2);
            while !sender_ready.load(std::sync::atomic::Ordering::Acquire) {
                assert!(
                    Instant::now() < until,
                    "actual original receive attempt started"
                );
                std::thread::sleep(Duration::from_millis(1));
            }
            for byte in b"abc" {
                std::thread::sleep(Duration::from_millis(400));
                client.write_all(&[*byte]).unwrap();
            }
        });
        let began = Instant::now();
        let mut bytes = [0; 3];
        read_for(&service, &mut server, &mut bytes, Duration::from_secs(1)).unwrap();
        assert_eq!(&bytes, b"abc");
        assert!(
            began.elapsed() >= Duration::from_secs(1),
            "positive-progress receives may span multiple attempt budgets"
        );
        task.join().unwrap();
    });
}
