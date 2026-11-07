use super::*;
use reverie_core::{
    decimal::UnsignedInteger,
    ids::{ContainerId, ProfileSessionId},
};
use std::{
    io::{Read, Write},
    os::unix::net::UnixListener,
};
const SID: &str = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
#[test]
fn existing_helper_typed_refusal_and_malformed_reply_have_distinct_attempt_results() {
    for (reply, expected_attempt, success) in [
        (
            b"{\"ok\":true,\"memoryHighBytes\":1073741824}\n".as_slice(),
            true,
            true,
        ),
        (
            b"{\"ok\":false,\"code\":\"WRITE_REFUSED\"}\n".as_slice(),
            false,
            false,
        ),
        (
            b"{\"ok\":true,\"memoryHighBytes\":1}\n".as_slice(),
            true,
            false,
        ),
        (
            b"{\"ok\":false,\"code\":\"EFFECT_UNCONFIRMED\"}\n".as_slice(),
            true,
            false,
        ),
        (b"".as_slice(), true, false),
    ] {
        let fixture = KernelFixture::new();
        let path = fixture.root.join("helper.sock");
        let listener = UnixListener::bind(&path).unwrap();
        let reply = reply.to_owned();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut payload = Vec::new();
            while payload.last() != Some(&b'\n') {
                let mut byte = [0];
                assert_eq!(socket.read(&mut byte).unwrap(), 1);
                payload.push(byte[0]);
            }
            let expected = reverie_contracts::worker_memory::helper_request(
                &ProfileSessionId::parse(SID).unwrap(),
                &ContainerId::parse(&"c".repeat(64)).unwrap(),
            );
            assert_eq!(payload, expected);
            socket.write_all(&reply).unwrap();
        });
        let mut attempted = false;
        let result = super::super::helper::request(
            &path,
            &ProfileSessionId::parse(SID).unwrap(),
            &ContainerId::parse(&"c".repeat(64)).unwrap(),
            &UnsignedInteger::from_u64(1_073_741_824),
            end(),
            &mut attempted,
        );
        server.join().unwrap();
        assert_eq!(attempted, expected_attempt);
        let result = classify(result, attempted);
        assert_eq!(result.is_ok(), success);
        if expected_attempt && !success {
            assert!(matches!(
                result,
                Err(LaptopError::MemoryEffectUnconfirmed(_))
            ));
        }
        assert_eq!(
            fs::read_to_string(fixture.root.join("cgroup/laptop/memory.high")).unwrap(),
            "max\n"
        );
    }
}
#[test]
fn helper_unavailable_or_expired_never_falls_back_to_direct_write() {
    let fixture = KernelFixture::new();
    for deadline in [Instant::now(), end()] {
        let mut attempted = false;
        let result = super::super::helper::request(
            &fixture.root.join("absent.sock"),
            &ProfileSessionId::parse(SID).unwrap(),
            &ContainerId::parse(&"c".repeat(64)).unwrap(),
            &UnsignedInteger::from_u64(1024),
            deadline,
            &mut attempted,
        );
        assert!(result.is_err());
        assert!(!attempted);
        assert_eq!(
            fs::read_to_string(fixture.root.join("cgroup/laptop/memory.high")).unwrap(),
            "max\n"
        );
    }
}
#[test]
fn incomplete_helper_frame_times_out_inside_the_original_absolute_budget() {
    let fixture = KernelFixture::new();
    let path = fixture.root.join("helper.sock");
    let listener = UnixListener::bind(&path).unwrap();
    let server = std::thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        let mut raw = [0; 512];
        socket
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let _ = socket.read(&mut raw).unwrap();
        socket.write_all(b"{").unwrap();
        std::thread::sleep(Duration::from_millis(150));
    });
    let mut attempted = false;
    let begin = Instant::now();
    let result = super::super::helper::request(
        &path,
        &ProfileSessionId::parse(SID).unwrap(),
        &ContainerId::parse(&"c".repeat(64)).unwrap(),
        &UnsignedInteger::from_u64(1024),
        begin + Duration::from_millis(50),
        &mut attempted,
    );
    assert!(begin.elapsed() < Duration::from_secs(1));
    assert!(matches!(
        classify(result, attempted),
        Err(LaptopError::MemoryEffectUnconfirmed(_))
    ));
    server.join().unwrap();
}
