use super::*;
use reverie_host::broker_listener::{read_frame, write_frame};
use std::{
    fs,
    os::unix::fs::{MetadataExt, PermissionsExt},
    path::Path,
    sync::{OnceLock, atomic::AtomicUsize},
};

#[derive(Default)]
struct Fake {
    log: Mutex<Vec<String>>,
    uid: Option<u32>,
    budget: Option<Duration>,
    hang_launch: AtomicBool,
    reports: AtomicUsize,
    office_close_fails: bool,
    first_stop: OnceLock<Instant>,
    block_watchdog: AtomicBool,
    block_lease: AtomicBool,
    lease_closes: AtomicUsize,
    watchdog_exits: AtomicUsize,
}
impl Fake {
    fn me() -> u32 {
        fs::metadata("/proc/self").unwrap().uid()
    }
    fn note(&self, entry: impl Into<String>) {
        self.log.lock().unwrap().push(entry.into());
    }
    fn log(&self) -> Vec<String> {
        self.log.lock().unwrap().clone()
    }
}
impl BrokerCore for Fake {
    fn uid(&self) -> u32 {
        self.uid.unwrap_or_else(Self::me)
    }
    fn connection_limit(&self) -> usize {
        4
    }
    fn check_pool(&self) -> Result<(), Refusal> {
        self.note("check_pool");
        Ok(())
    }
    fn recover(&self) -> Result<(), Refusal> {
        self.note("recover");
        Ok(())
    }
    fn start_lease_peer(&self) {
        self.note("lease");
    }
    fn watchdog(&self, closed: &AtomicBool) {
        self.note("watchdog");
        while !closed.load(Ordering::Acquire) || self.block_watchdog.load(Ordering::Acquire) {
            std::thread::sleep(Duration::from_millis(5));
        }
        self.watchdog_exits.fetch_add(1, Ordering::SeqCst);
    }
    fn report(&self, mut stream: UnixStream) {
        // The owner reads its own frame, proving it arrived unread.
        let (kind, _) = read_frame(&mut stream).unwrap();
        assert_eq!(kind, b'T');
        self.reports.fetch_add(1, Ordering::SeqCst);
        write_frame(&mut stream, b'J', b"{}").unwrap();
    }
    fn launch(&self, kind: u8, _: &mut UnixStream, _: &[u8], _: u32) -> Result<(), Refusal> {
        self.note(format!("launch {}", kind as char));
        while self.hang_launch.load(Ordering::Acquire) {
            std::thread::sleep(Duration::from_millis(5));
        }
        Ok(())
    }
    fn control(&self, route: ControlRoute, _: &[u8], _: u32) -> Result<BrokerReply, Refusal> {
        self.note(format!("control {route:?}"));
        Ok(BrokerReply::object(vec![
            ("action", BrokerReply::string("status")),
            ("success", BrokerReply::boolean(true)),
        ]))
    }
    // The real first-stop contract: repeated calls never extend the budget.
    fn request_stop(&self) -> Instant {
        *self.first_stop.get_or_init(Instant::now) + self.budget.unwrap_or(Duration::from_secs(5))
    }
    fn close_lease_peer(&self) -> bool {
        self.lease_closes.fetch_add(1, Ordering::SeqCst);
        while self.block_lease.load(Ordering::Acquire) {
            std::thread::sleep(Duration::from_millis(5));
        }
        true
    }
    fn request_office_close(&self) -> bool {
        !self.office_close_fails
    }
    fn close_offices(&self, _: Instant) -> bool {
        !self.office_close_fails
    }
    fn reap_viewers(&self) {}
    fn settle(&self, _: Instant) -> Vec<&'static str> {
        Vec::new()
    }
}
struct Echo(&'static str);
impl StreamOwner for Echo {
    fn serve(&self, _: &mut UnixStream, _: &[u8], _: u32) -> Result<Option<BrokerReply>, Refusal> {
        Ok(Some(BrokerReply::object(vec![(
            "owner",
            BrokerReply::string(self.0),
        )])))
    }
}
fn all_owners() -> Owners {
    Owners {
        chat_images: Some(Arc::new(Echo("M"))),
        host_resume: Some(Arc::new(Echo("Y"))),
        resource_actor: Some(Arc::new(Echo("Q"))),
        goal_custody: Some(Arc::new(Echo("G"))),
    }
}
fn scratch(name: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!(
        "broker-service-{name}-{}-{}",
        std::process::id(),
        Instant::now().elapsed().as_nanos() ^ u128::from(rand_tag())
    ));
    fs::create_dir_all(&root).unwrap();
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
    root.join("control").join("broker.sock")
}
fn rand_tag() -> u32 {
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    NEXT.fetch_add(1, Ordering::SeqCst) as u32
}
/// Start a service on its own thread and wait for the socket.
fn running(
    core: Arc<Fake>,
    owners: Owners,
    socket: &Path,
) -> (Arc<BrokerService>, JoinHandle<Result<(), ServiceError>>) {
    let service = Arc::new(BrokerService::new(core, owners, socket.to_owned()));
    let serving = service.clone();
    let handle = std::thread::spawn(move || serving.serve());
    let start = Instant::now();
    while UnixStream::connect(socket).is_err() {
        assert!(
            start.elapsed() < Duration::from_secs(5),
            "socket never bound"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
    (service, handle)
}
fn ask(socket: &Path, kind: u8, payload: &[u8]) -> (u8, Vec<u8>) {
    let mut stream = UnixStream::connect(socket).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    write_frame(&mut stream, kind, payload).unwrap();
    read_frame(&mut stream).unwrap()
}

// P6: a missing injected owner refuses before any startup effect.
#[test]
fn missing_owner_refuses_before_any_effect() {
    for missing in InjectedKind::ALL {
        let core = Arc::new(Fake::default());
        let mut owners = all_owners();
        match missing {
            InjectedKind::ChatImages => owners.chat_images = None,
            InjectedKind::HostResume => owners.host_resume = None,
            InjectedKind::ResourceActor => owners.resource_actor = None,
            InjectedKind::GoalCustody => owners.goal_custody = None,
        }
        let socket = scratch("preflight");
        let service = Arc::new(BrokerService::new(core.clone(), owners, socket.clone()));
        // Bounded: a service that skipped preflight would serve until closed.
        let serving = service.clone();
        let handle = std::thread::spawn(move || serving.serve());
        let start = Instant::now();
        while !handle.is_finished() && start.elapsed() < Duration::from_secs(2) {
            std::thread::sleep(Duration::from_millis(5));
        }
        if !handle.is_finished() {
            service.request_close();
            let _ = handle.join();
            panic!("{missing:?}: serve started instead of refusing");
        }
        assert_eq!(
            handle.join().unwrap(),
            Err(ServiceError::Incomplete(vec![missing]))
        );
        assert!(core.log().is_empty(), "{missing:?}: {:?}", core.log());
        assert!(fs::symlink_metadata(socket.parent().unwrap()).is_err());
    }
}

#[test]
fn startup_runs_in_the_legacy_order_and_close_removes_the_socket() {
    let core = Arc::new(Fake::default());
    let socket = scratch("order");
    let (service, handle) = running(core.clone(), all_owners(), &socket);
    assert_eq!(
        core.log()[..4],
        ["check_pool", "recover", "lease", "watchdog"]
    );
    assert_eq!(fs::symlink_metadata(&socket).unwrap().mode() & 0o777, 0o600);
    service.request_close();
    assert_eq!(handle.join().unwrap(), Ok(()));
    assert!(fs::symlink_metadata(&socket).is_err());
}

#[test]
fn control_routes_reach_the_core_and_reply_in_python_form() {
    let core = Arc::new(Fake::default());
    let socket = scratch("control");
    let (service, handle) = running(core.clone(), all_owners(), &socket);
    let (kind, reply) = ask(&socket, b'C', br#"{"action": "status"}"#);
    assert_eq!(
        (kind, reply.as_slice()),
        (b'J', &br#"{"action": "status", "success": true}"#[..])
    );
    let (kind, reply) = ask(
        &socket,
        b'C',
        br#"{"action": "stop-agent", "sessionId": "a", "fence": "f"}"#,
    );
    assert_eq!(
        (kind, reply.as_slice()),
        (b'E', &b"Invalid stop-agent request"[..])
    );
    // The named difference, end to end: exactly the fixed refusal text.
    let (kind, reply) = ask(&socket, b'C', b"not json");
    assert_eq!(
        (kind, reply.as_slice()),
        (b'E', &b"Invalid office power request"[..])
    );
    let (kind, reply) = ask(&socket, b'C', b"{}");
    assert_eq!(
        (kind, reply.as_slice()),
        (b'E', &b"Worker transport failed"[..])
    );
    service.request_close();
    assert_eq!(handle.join().unwrap(), Ok(()));
}

// P7: website power is not broker close; the service keeps serving.
#[test]
fn office_power_shutdown_does_not_close_the_broker() {
    let core = Arc::new(Fake::default());
    let socket = scratch("power");
    let (service, handle) = running(core.clone(), all_owners(), &socket);
    let (kind, _) = ask(&socket, b'C', br#"{"action": "shutdown"}"#);
    assert_eq!(kind, b'J');
    assert!(!service.closing_flag().load(Ordering::Acquire));
    let (kind, _) = ask(&socket, b'C', br#"{"action": "status"}"#);
    assert_eq!(
        kind, b'J',
        "the listener still accepts after a power shutdown"
    );
    service.request_close();
    assert_eq!(handle.join().unwrap(), Ok(()));
}

#[test]
fn injected_owners_and_report_handoff() {
    let core = Arc::new(Fake::default());
    let socket = scratch("owners");
    let (service, handle) = running(core.clone(), all_owners(), &socket);
    for (kind, owner) in [(b'M', "M"), (b'G', "G"), (b'Q', "Q"), (b'Y', "Y")] {
        let (reply_kind, reply) = ask(&socket, kind, b"{}");
        assert_eq!(reply_kind, b'J');
        assert_eq!(reply, format!(r#"{{"owner": "{owner}"}}"#).into_bytes());
    }
    let (kind, reply) = ask(&socket, b'C', br#"{"action": "worker-resume-channel"}"#);
    assert_eq!((kind, reply.as_slice()), (b'J', &br#"{"owner": "Y"}"#[..]));
    let (kind, _) = ask(&socket, b'T', b"{}");
    assert_eq!(kind, b'J');
    assert_eq!(core.reports.load(Ordering::SeqCst), 1);
    let (kind, reply) = ask(&socket, b'Z', b"{}");
    assert_eq!(
        (kind, reply.as_slice()),
        (b'E', &b"Expected worker launch request"[..])
    );
    service.request_close();
    assert_eq!(handle.join().unwrap(), Ok(()));
}

#[test]
fn foreign_peer_is_refused_before_any_frame() {
    let core = Arc::new(Fake {
        uid: Some(Fake::me() + 1),
        ..Fake::default()
    });
    let socket = scratch("peer");
    let (service, handle) = running(core.clone(), all_owners(), &socket);
    let mut stream = UnixStream::connect(&socket).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    // Nothing is sent: the refusal precedes any frame read.
    let (kind, reply) = read_frame(&mut stream).unwrap();
    assert_eq!(
        (kind, reply.as_slice()),
        (b'E', &b"Worker peer identity is not authorized"[..])
    );
    assert!(!core.log().iter().any(|e| e.starts_with("control")));
    service.request_close();
    assert_eq!(handle.join().unwrap(), Ok(()));
}

#[test]
fn a_handler_past_the_budget_is_reported_not_dropped() {
    let core = Arc::new(Fake {
        budget: Some(Duration::from_millis(200)),
        ..Fake::default()
    });
    core.hang_launch.store(true, Ordering::Release);
    let socket = scratch("hang");
    let (service, handle) = running(core.clone(), all_owners(), &socket);
    let mut stream = UnixStream::connect(&socket).unwrap();
    write_frame(&mut stream, b'J', b"{}").unwrap();
    while !core.log().iter().any(|e| e == "launch J") {
        std::thread::sleep(Duration::from_millis(5));
    }
    service.request_close();
    assert_eq!(
        handle.join().unwrap(),
        Err(ServiceError::Unconfirmed(vec![
            "DEADLINE_EXHAUSTED",
            "HANDLER_ACTIVE"
        ]))
    );
    core.hang_launch.store(false, Ordering::Release);
}

#[test]
fn office_close_failure_is_its_legacy_code() {
    let core = Arc::new(Fake {
        office_close_fails: true,
        ..Fake::default()
    });
    let socket = scratch("office");
    let (service, handle) = running(core, all_owners(), &socket);
    service.request_close();
    assert_eq!(
        handle.join().unwrap(),
        Err(ServiceError::Unconfirmed(vec!["OFFICE_CLOSE_FAILED"]))
    );
}

// F1: a watchdog past the budget stays owned; a later settle joins that same
// attempt, with no second lease close and no new budget.
#[test]
fn a_late_watchdog_is_retained_and_settled_later() {
    let core = Arc::new(Fake {
        budget: Some(Duration::from_millis(150)),
        ..Fake::default()
    });
    core.block_watchdog.store(true, Ordering::Release);
    let socket = scratch("late-watchdog");
    let (service, handle) = running(core.clone(), all_owners(), &socket);
    service.request_close();
    assert_eq!(
        handle.join().unwrap(),
        Err(ServiceError::Unconfirmed(vec![
            "DEADLINE_EXHAUSTED",
            "SUPERVISOR_ACTIVE"
        ]))
    );
    let first = *core.first_stop.get().unwrap();
    assert_eq!(
        service.settle_retained(),
        Err(ServiceError::Unconfirmed(vec!["SUPERVISOR_ACTIVE"]))
    );
    core.block_watchdog.store(false, Ordering::Release);
    while core.watchdog_exits.load(Ordering::SeqCst) == 0 {
        std::thread::sleep(Duration::from_millis(5));
    }
    assert_eq!(service.settle_retained(), Ok(()));
    assert_eq!(core.watchdog_exits.load(Ordering::SeqCst), 1);
    assert_eq!(
        core.lease_closes.load(Ordering::SeqCst),
        1,
        "no second lease close"
    );
    assert_eq!(*core.first_stop.get().unwrap(), first, "no renewed budget");
}

#[test]
fn a_late_lease_close_is_retained_and_settled_later() {
    let core = Arc::new(Fake {
        budget: Some(Duration::from_millis(150)),
        ..Fake::default()
    });
    core.block_lease.store(true, Ordering::Release);
    let socket = scratch("late-lease");
    let (service, handle) = running(core.clone(), all_owners(), &socket);
    service.request_close();
    assert_eq!(
        handle.join().unwrap(),
        Err(ServiceError::Unconfirmed(vec![
            "DEADLINE_EXHAUSTED",
            "LEASE_PEER_ACTIVE"
        ]))
    );
    core.block_lease.store(false, Ordering::Release);
    let start = Instant::now();
    while service.settle_retained().is_err() {
        assert!(
            start.elapsed() < Duration::from_secs(5),
            "lease never settled"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
    assert_eq!(core.lease_closes.load(Ordering::SeqCst), 1);
}

// F1: a poisoned records lock is recovered, so a new handler is still owned
// and joined at close.
#[test]
fn a_poisoned_records_lock_keeps_the_handler_owned() {
    let core = Arc::new(Fake::default());
    let socket = scratch("poison");
    let (service, handle) = running(core.clone(), all_owners(), &socket);
    let records = service.records.clone();
    let _ = std::thread::spawn(move || {
        let _guard = records.lock().unwrap();
        panic!("poison the records lock");
    })
    .join();
    assert!(service.records.is_poisoned());
    let (kind, _) = ask(&socket, b'C', br#"{"action": "status"}"#);
    assert_eq!(kind, b'J');
    service.request_close();
    assert_eq!(handle.join().unwrap(), Ok(()));
    assert!(
        service.records().is_empty(),
        "the handler was joined, not dropped"
    );
}

// F2: a bind failure after the watchdog and lease started returns its cause
// together with the cleanup outcome.
#[test]
fn bind_failure_returns_cause_and_cleanup_together() {
    let core = Arc::new(Fake {
        office_close_fails: true,
        ..Fake::default()
    });
    // A socket path longer than sun_path passes every check before bind.
    let socket = scratch("bind").with_file_name("s".repeat(120));
    let service = BrokerService::new(core.clone(), all_owners(), socket);
    match service.serve() {
        Err(ServiceError::Startup { cause, cleanup }) => {
            assert!(!cause.is_empty());
            assert_eq!(cleanup, vec!["OFFICE_CLOSE_FAILED"]);
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(core.lease_closes.load(Ordering::SeqCst), 1);
    assert_eq!(core.watchdog_exits.load(Ordering::SeqCst), 1);
}
