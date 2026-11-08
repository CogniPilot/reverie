//! Actual owned kernel peers only. No controller birth, executable approval,
//! registered broker, maintenance or provider grant is supplied by this fixture.
use super::*;
use crate::website_facts::{ProcessSnapshot, WebsiteProcessObserver};
use reverie_contracts::worker_pool::BrokerBirthData;
use std::os::fd::AsRawFd;
struct Fixture {
    stream: Option<UnixStream>,
    other: Option<UnixStream>,
    pidfd: Option<OwnedFd>,
    unknown: bool,
    process: ProcessSnapshot,
}
impl Fixture {
    fn new() -> Self {
        let mut observer = WebsiteProcessObserver::default();
        let process = observer
            .observe_current_broker(Instant::now() + Duration::from_secs(5))
            .unwrap();
        observer.assert_finalized().unwrap();
        let (stream, other) = UnixStream::pair().unwrap();
        let mut owner = Self {
            stream: Some(stream),
            other: Some(other),
            pidfd: None,
            unknown: false,
            process,
        };
        owner.pidfd = Some(
            nix::sys::socket::getsockopt(
                owner.stream.as_ref().unwrap(),
                nix::sys::socket::sockopt::PeerPidfd,
            )
            .unwrap(),
        );
        owner
    }
    fn data(&self, pid: u32, uid: u32, start: String) -> BrokerBirthData {
        BrokerBirthData::from_observations(
            pid,
            start,
            [uid, nix::unistd::getgid().as_raw()],
            self.process.executable(),
            self.process.namespaces(),
            self.process.argv_digest().as_str().into(),
        )
        .unwrap()
    }
    fn verify(&mut self, expected: &BrokerBirthData) -> Result<()> {
        verify_peer(
            self.stream.as_ref().unwrap(),
            self.pidfd.as_ref().unwrap(),
            expected,
            &mut self.unknown,
        )
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = close_peer(&mut self.stream, &mut self.pidfd, &mut self.unknown);
        if let Some(other) = self.other.take() {
            let _ = native::close(File::from(OwnedFd::from(other)));
        }
    }
}
fn isolated(name: &str) -> bool {
    crate::test_process::isolate_case(&format!("worker_pool::endpoint::tests::{name}"))
}
#[test]
fn original_kernel_peer_is_exact_while_same_uid_different_pid_and_incarnation_refuse() {
    if isolated("original_kernel_peer_is_exact_while_same_uid_different_pid_and_incarnation_refuse")
    {
        return;
    }
    let mut fixture = Fixture::new();
    let pid = std::process::id();
    let uid = native::uid();
    let expected = fixture.data(pid, uid, fixture.process.start().as_str().into());
    fixture.verify(&expected).unwrap();
    for (other_pid, other_uid) in [(pid + 1, uid), (pid, uid + 1)] {
        let wrong = fixture.data(
            other_pid,
            other_uid,
            fixture.process.start().as_str().into(),
        );
        assert_eq!(
            fixture.verify(&wrong).unwrap_err().code(),
            "WORKER_POOL_BROKER_PEER_CHANGED"
        );
    }
    let wrong = fixture.data(pid, uid, format!("{}1", fixture.process.start().as_str()));
    assert_eq!(
        fixture.verify(&wrong).unwrap_err().code(),
        "WORKER_POOL_BROKER_INCARNATION_CHANGED"
    );
    assert!(!fixture.unknown);
    fixture.verify(&expected).unwrap();
    close_peer(
        &mut fixture.stream,
        &mut fixture.pidfd,
        &mut fixture.unknown,
    )
    .unwrap();
}
#[test]
fn consumed_peer_observation_close_stays_unknown_after_known_socket_cleanup() {
    if isolated("consumed_peer_observation_close_stays_unknown_after_known_socket_cleanup") {
        return;
    }
    let mut fixture = Fixture::new();
    let expected = fixture.data(
        std::process::id(),
        native::uid(),
        fixture.process.start().as_str().into(),
    );
    native::test_faults::set(None, true);
    assert!(fixture.verify(&expected).unwrap_err().close_unknown());
    assert!(fixture.unknown);
    assert_eq!(
        fixture.verify(&expected).unwrap_err().code(),
        "WORKER_POOL_CONTROL_CLOSE_UNKNOWN"
    );
    assert!(
        close_peer(
            &mut fixture.stream,
            &mut fixture.pidfd,
            &mut fixture.unknown
        )
        .is_err()
    );
    assert!(fixture.stream.is_none() && fixture.pidfd.is_none());
    assert!(
        close_peer(
            &mut fixture.stream,
            &mut fixture.pidfd,
            &mut fixture.unknown
        )
        .is_err()
    );
}

fn original_native(slot: &Cell<PeerSettlement>) -> (PeerNative<'_>, UnixStream) {
    let (stream, other) = UnixStream::pair().unwrap();
    let mut owner = PeerNative {
        stream: Some(stream),
        pidfd: None,
        closed: false,
        close_unknown: false,
        completion: Some(slot),
    };
    owner.pidfd = Some(
        nix::sys::socket::getsockopt(
            owner.stream.as_ref().unwrap(),
            nix::sys::socket::sockopt::PeerPidfd,
        )
        .unwrap(),
    );
    (owner, other)
}
#[test]
fn abandoned_original_peer_keeps_actual_fds_and_endpoint_slot_fenced() {
    if isolated("abandoned_original_peer_keeps_actual_fds_and_endpoint_slot_fenced") {
        return;
    }
    let slot = Cell::new(PeerSettlement::Held);
    let (owner, other) = original_native(&slot);
    let original = [
        owner.stream.as_ref().unwrap().as_raw_fd(),
        owner.pidfd.as_ref().unwrap().as_raw_fd(),
    ];
    let identities = original.map(|fd| {
        let m = fs::metadata(format!("/proc/self/fd/{fd}")).unwrap();
        (m.dev(), m.ino())
    });
    drop(owner);
    assert_eq!(
        require_peer_settled(&slot).unwrap_err().code(),
        "WORKER_POOL_CONTROL_PEER_RETAINED"
    );
    for (fd, identity) in original.into_iter().zip(identities) {
        let m = fs::metadata(format!("/proc/self/fd/{fd}")).unwrap();
        assert_eq!((m.dev(), m.ino()), identity);
    }
    let mut stale = PeerNative {
        stream: None,
        pidfd: None,
        closed: false,
        close_unknown: false,
        completion: None,
    };
    stale.close().unwrap();
    assert_eq!(
        require_peer_settled(&slot).unwrap_err().code(),
        "WORKER_POOL_CONTROL_PEER_RETAINED"
    );
    native::close(File::from(OwnedFd::from(other))).unwrap();
    // Only this isolated process's exit closes the deliberately retained FDs.
}
#[test]
fn only_checked_original_native_close_settles_the_exact_endpoint_slot() {
    if isolated("only_checked_original_native_close_settles_the_exact_endpoint_slot") {
        return;
    }
    let slot = Cell::new(PeerSettlement::Held);
    let (mut owner, other) = original_native(&slot);
    let mut stale = PeerNative {
        stream: None,
        pidfd: None,
        closed: false,
        close_unknown: false,
        completion: None,
    };
    stale.close().unwrap();
    assert!(require_peer_settled(&slot).is_err());
    owner.close().unwrap();
    require_peer_settled(&slot).unwrap();
    owner.close().unwrap();
    native::close(File::from(OwnedFd::from(other))).unwrap();
}
