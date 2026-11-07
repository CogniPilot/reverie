//! Actual owned AF_UNIX sockets, kernel peers, directory modes and same cap.
//! No company, container Engine, service endpoint or listener outside fixtures.
use super::super::{BrokerListenerError, PreparedBrokerListener};
use super::*;
use reverie_contracts::worker_schema::WorkerEnvelope;
use std::os::{
    fd::{AsRawFd, OwnedFd},
    unix::fs::MetadataExt,
};
fn isolated(name: &str) -> bool {
    crate::test_process::isolate_case(&format!("worker_reports::tests::listener::{name}"))
}
fn configuration(fixture: &Fixture, socket: &std::path::Path) -> WorkerEnvelope {
    let root = &fixture.root;
    let raw = serde_json::json!({"version":1,"deployment":"reports","image":format!("sha256:{}","a".repeat(64)),"serverContainer":"reports-server","socket":socket,
        "stateRoot":root.join("state"),"companyFile":root.join("company.json"),"companyRoot":root.join("company"),"scratchRoot":root.join("scratch"),"apiSocketRoot":root.join("api"),
        "budgetMode":"admission","uid":crate::native::uid(),"gid":crate::native::uid(),"memoryMiB":1024,"poolMemoryMiB":8192,"poolTasksMax":512,"cgroupParent":"reverie-workers.slice","pidsLimit":128,"cpus":1,"maxWorkers":1,
        "mounts":[{"source":"/owned","destination":"/work","readOnly":false}],"maintenanceSessions":[]});
    WorkerEnvelope::capture(worker_config::decode(&serde_json::to_vec(&raw).unwrap()).unwrap())
        .unwrap()
}
fn prepared(fixture: &Fixture, path: &std::path::Path) -> PreparedBrokerListener {
    fixture
        .runtime
        .prepare_broker_listener(&configuration(fixture, path))
        .unwrap_or_else(|error| panic!("{error}"))
}
#[test]
fn actual_listener_registers_unread_connections_in_the_same_report_and_launch_cap() {
    if isolated("actual_listener_registers_unread_connections_in_the_same_report_and_launch_cap") {
        return;
    }
    let fixture = Fixture::new();
    let service = Arc::new(fixture.service());
    let path = fixture.root.join("broker.sock");
    let mut listener = prepared(&fixture, &path)
        .bind()
        .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(fs::metadata(&path).unwrap().mode() & 0o777, 0o600);
    let mut client = UnixStream::connect(&path).unwrap();
    send(&mut client, b'T', REQUEST);
    let registered = listener.accept(&service).unwrap().unwrap();
    assert_eq!(
        service.records.lock().unwrap().len(),
        1,
        "registered BEFORE any read"
    );
    assert!(matches!(
        registered
            .receive(&fixture.collector, &super::launch::configuration())
            .unwrap(),
        AcceptedWorkerConnection::ReportCompleted
    ));
    assert_eq!(reply(&mut client).0, b'J');
    let mut held = Vec::new();
    for _ in 0..service.limit {
        let client = UnixStream::connect(&path).unwrap();
        held.push((client, listener.accept(&service).unwrap().unwrap()));
    }
    let mut refused = UnixStream::connect(&path).unwrap();
    assert!(matches!(
        listener.accept(&service),
        Err(BrokerListenerError::Report(WorkerReportError::Stopping))
    ));
    refused
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    assert_eq!(refused.read(&mut [0]).unwrap(), 0);
    assert_eq!(service.records.lock().unwrap().len(), service.limit);
    for (_client, record) in held {
        record.close().unwrap();
    }
    listener.close().unwrap();
    assert!(!path.exists());
    service.close(end()).unwrap();
}
#[test]
fn live_and_non_socket_names_are_preserved_and_only_stale_same_inode_is_removed() {
    if isolated("live_and_non_socket_names_are_preserved_and_only_stale_same_inode_is_removed") {
        return;
    }
    let fixture = Fixture::new();
    let path = fixture.root.join("broker.sock");
    fs::write(&path, b"foreign file").unwrap();
    let mut failed = fixture
        .runtime
        .prepare_broker_listener(&configuration(&fixture, &path))
        .err()
        .unwrap();
    failed.close().unwrap();
    assert_eq!(fs::read(&path).unwrap(), b"foreign file");
    fs::remove_file(&path).unwrap();
    let live = UnixListener::bind(&path).unwrap();
    let before = fs::symlink_metadata(&path).unwrap();
    let mut failed = fixture
        .runtime
        .prepare_broker_listener(&configuration(&fixture, &path))
        .err()
        .unwrap();
    failed.close().unwrap();
    let after = fs::symlink_metadata(&path).unwrap();
    assert_eq!(
        (before.dev(), before.ino(), before.mode()),
        (after.dev(), after.ino(), after.mode())
    );
    drop(live);
    let mut prepared = prepared(&fixture, &path);
    assert!(
        !path.exists(),
        "ECONNREFUSED removed only actual pinned old socket"
    );
    prepared.close().unwrap();
}
#[test]
fn full_foreign_backlog_refuses_without_blocking_or_unlinking_or_chmodding_its_name() {
    if isolated("full_foreign_backlog_refuses_without_blocking_or_unlinking_or_chmodding_its_name")
    {
        return;
    }
    use nix::sys::socket::{self, AddressFamily, Backlog, SockFlag, SockType, UnixAddr};
    let fixture = Fixture::new();
    let path = fixture.root.join("broker.sock");
    let foreign = UnixListener::bind(&path).unwrap();
    socket::listen(&foreign, Backlog::new(0).unwrap()).unwrap();
    let address = UnixAddr::new(&path).unwrap();
    let mut clients = Vec::<OwnedFd>::new();
    let mut full = false;
    for _ in 0..32 {
        let fd = socket::socket(
            AddressFamily::Unix,
            SockType::Stream,
            SockFlag::SOCK_NONBLOCK | SockFlag::SOCK_CLOEXEC,
            None,
        )
        .unwrap();
        let result = socket::connect(fd.as_raw_fd(), &address);
        clients.push(fd);
        match result {
            Ok(()) => (),
            Err(nix::errno::Errno::EAGAIN) => {
                full = true;
                break;
            }
            Err(error) => panic!("owned backlog: {error}"),
        }
    }
    assert!(full, "actual full private listener backlog");
    let original = fs::symlink_metadata(&path).unwrap();
    let mut failure = fixture
        .runtime
        .prepare_broker_listener(&configuration(&fixture, &path))
        .err()
        .unwrap();
    assert!(
        matches!(failure.cause(),BrokerListenerError::Io(error) if error.raw_os_error()==Some(libc::EAGAIN))
    );
    failure.close().unwrap();
    let current = fs::symlink_metadata(&path).unwrap();
    assert_eq!(
        (original.dev(), original.ino(), original.mode()),
        (current.dev(), current.ino(), current.mode())
    );
    for fd in clients {
        crate::native::close(fs::File::from(fd)).unwrap();
    }
    drop(foreign);
}
#[test]
fn replacement_after_bound_listener_close_is_preserved_and_original_origin_stays_retained() {
    if isolated(
        "replacement_after_bound_listener_close_is_preserved_and_original_origin_stays_retained",
    ) {
        return;
    }
    let fixture = Fixture::new();
    let weak = Arc::downgrade(fixture.runtime.installed_engine());
    let path = fixture.root.join("broker.sock");
    let mut listener = prepared(&fixture, &path)
        .bind()
        .unwrap_or_else(|error| panic!("{error}"));
    fs::remove_file(&path).unwrap();
    let replacement = UnixListener::bind(&path).unwrap();
    let original = fs::symlink_metadata(&path).unwrap();
    assert!(listener.close().is_err());
    assert!(listener.close().is_err());
    assert_eq!(fs::symlink_metadata(&path).unwrap().ino(), original.ino());
    drop(listener);
    drop(replacement);
    drop(fixture);
    assert!(
        weak.upgrade().is_some(),
        "original engine survives unresolved name custody"
    );
}
#[test]
fn consumed_close_refusal_is_sticky_while_clean_close_does_not_quarantine_origin() {
    if isolated("consumed_close_refusal_is_sticky_while_clean_close_does_not_quarantine_origin") {
        return;
    }
    for refusal in [false, true] {
        let fixture = Fixture::new();
        let weak = Arc::downgrade(fixture.runtime.installed_engine());
        let path = fixture.root.join("broker.sock");
        let mut listener = prepared(&fixture, &path)
            .bind()
            .unwrap_or_else(|error| panic!("{error}"));
        if refusal {
            crate::native::test_faults::set(None, true);
        }
        assert_eq!(listener.close().is_err(), refusal);
        let mut sentinel = fs::File::create(fixture.root.join("sentinel")).unwrap();
        assert_eq!(listener.close().is_err(), refusal);
        sentinel.write_all(b"not a retried consumed fd").unwrap();
        drop(sentinel);
        drop(listener);
        drop(fixture);
        assert_eq!(weak.upgrade().is_some(), refusal);
    }
}
#[test]
fn foreign_runtime_and_closed_preparation_refuse_before_accept_or_rebind() {
    if isolated("foreign_runtime_and_closed_preparation_refuse_before_accept_or_rebind") {
        return;
    }
    let fixture = Fixture::new();
    let other = Fixture::new();
    let service = Arc::new(fixture.service());
    let foreign = Arc::new(other.service());
    let path = fixture.root.join("broker.sock");
    let mut listener = prepared(&fixture, &path)
        .bind()
        .unwrap_or_else(|error| panic!("{error}"));
    let _client = UnixStream::connect(&path).unwrap();
    assert!(listener.accept(&foreign).is_err());
    assert!(foreign.records.lock().unwrap().is_empty());
    listener.accept(&service).unwrap().unwrap().close().unwrap();
    listener.close().unwrap();
    let mut closed = prepared(&fixture, &path);
    closed.close().unwrap();
    assert!(closed.bind().is_err());
    assert!(!path.exists());
    service.close(end()).unwrap();
    foreign.close(end()).unwrap();
}
#[test]
fn raw_parent_creation_preserves_default_parent_modes_and_refuses_final_symlink() {
    if isolated("raw_parent_creation_preserves_default_parent_modes_and_refuses_final_symlink") {
        return;
    }
    let fixture = Fixture::new();
    let control = fixture.root.join("control");
    fs::create_dir(&control).unwrap();
    let mode = fs::metadata(control).unwrap().mode() & 0o777;
    let parent = fixture.root.join("new/last");
    let path = parent.join("broker.sock");
    let mut own = prepared(&fixture, &path);
    assert_eq!(
        fs::metadata(fixture.root.join("new")).unwrap().mode() & 0o777,
        mode
    );
    assert_eq!(fs::metadata(&parent).unwrap().mode() & 0o777, 0o700);
    own.close().unwrap();
    std::os::unix::fs::symlink(&parent, fixture.root.join("alias")).unwrap();
    let alias = fixture.root.join("alias/broker.sock");
    let mut failure = fixture
        .runtime
        .prepare_broker_listener(&configuration(&fixture, &alias))
        .err()
        .unwrap();
    failure.close().unwrap();
    assert!(!path.exists());
}
