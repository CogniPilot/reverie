use super::*;
mod launch;
mod reference;
mod retention;
use crate::engine_metadata::EngineBootstrap;
use reverie_contracts::worker_config;
use reverie_core::{
    resources::{BudgetMode, CpuQuota, ResourcePolicy},
    worker_schema::{WorkerBase, WorkerIds},
    worker_wire::{HEADER_BYTES, MAX_FRAME, WorkerFrameHeader},
};
use std::{
    cell::{Cell, RefCell},
    collections::BTreeMap,
    fs,
    io::{Read, Write},
    os::unix::{fs::PermissionsExt, net::UnixListener},
    path::PathBuf,
    sync::atomic::AtomicUsize,
};
static NEXT: AtomicUsize = AtomicUsize::new(0);
thread_local! { static CLOSE_REFUSAL: Cell<bool> = const { Cell::new(false) }; }
thread_local! { static CLOSE_GATE: RefCell<Option<Arc<crate::captured_client::test_hooks::Gate>>> = const { RefCell::new(None) }; }
pub(super) fn refuse_close() -> bool {
    CLOSE_REFUSAL.with(|flag| flag.replace(false))
}
pub(super) fn before_close() {
    if let Some(gate) = CLOSE_GATE.with(|slot| slot.borrow_mut().take()) {
        gate.entered.store(true, Ordering::Release);
        while !gate.released.load(Ordering::Acquire) {
            std::thread::sleep(Duration::from_millis(1));
        }
    }
}
pub(super) struct Fixture {
    root: PathBuf,
    runtime: WorkerRuntime,
    collector: CommandTelemetry,
}
impl Fixture {
    pub(super) fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "report-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::AcqRel)
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        // Disabled telemetry is a genuine captured feature configuration. Any
        // accidental engine query uses this actual test executable and fails.
        let bootstrap = EngineBootstrap::from_service(
            std::env::current_exe().unwrap().as_os_str(),
            BTreeMap::new(),
            root.clone(),
        )
        .unwrap();
        let base = WorkerBase::try_new(
            "reports".into(),
            "reports-server".into(),
            format!("sha256:{}", "a".repeat(64)),
            WorkerIds::try_new(crate::native::uid(), crate::native::uid()).unwrap(),
            1,
            ResourcePolicy::try_new(
                BudgetMode::Admission,
                1024,
                128,
                CpuQuota::from_integer(1).unwrap(),
                8192,
                512,
            )
            .unwrap(),
        )
        .unwrap();
        let runtime = WorkerRuntime::new(InstalledWorkerEngine::new(bootstrap), &base);
        let collector =
            CommandTelemetry::capture(&runtime, &worker_config::decode(b"{}").unwrap()).unwrap();
        Self {
            root,
            runtime,
            collector,
        }
    }
    pub(super) fn service(&self) -> WorkerReportService {
        WorkerReportService::from_runtime(&self.runtime)
    }
    pub(super) fn sockets(&self) -> (UnixStream, UnixStream) {
        let path = self
            .root
            .join(format!("s{}", NEXT.fetch_add(1, Ordering::AcqRel)));
        let listener = UnixListener::bind(&path).unwrap();
        let client = UnixStream::connect(&path).unwrap();
        let (server, _) = listener.accept().unwrap();
        client
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        (client, server)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root).unwrap();
    }
}
fn end() -> Instant {
    Instant::now() + Duration::from_secs(2)
}
fn send(client: &mut UnixStream, kind: u8, bytes: &[u8]) {
    client
        .write_all(
            &WorkerFrameHeader::for_payload(kind, bytes.len())
                .unwrap()
                .encode(),
        )
        .unwrap();
    client.write_all(bytes).unwrap();
}
fn reply(client: &mut UnixStream) -> (u8, Vec<u8>) {
    let mut header = [0; HEADER_BYTES];
    client.read_exact(&mut header).unwrap();
    let header = WorkerFrameHeader::decode(header);
    let mut payload = vec![0; header.payload_length() as usize];
    client.read_exact(&mut payload).unwrap();
    (header.kind(), payload)
}
const REQUEST: &[u8] = br#"{"v":1,"action":"command-failures","employee_ids":[]}"#;
#[test]
fn accepted_socket_uses_kernel_uid_and_closed_t_report_with_fragmented_header() {
    let fixture = Fixture::new();
    let service = WorkerReportService::from_runtime(&fixture.runtime);
    let (mut client, server) = fixture.sockets();
    // This collector deliberately refuses overlapping report readers. Build
    // the expected bytes before the real service can take its report lock.
    let expected = fixture
        .collector
        .command_failure_report(
            &reverie_contracts::command_telemetry::decode_report_request(REQUEST).unwrap(),
        )
        .unwrap();
    std::thread::scope(|scope| {
        let task = scope.spawn(|| service.handle(server, &fixture.collector));
        for byte in WorkerFrameHeader::for_payload(b'T', REQUEST.len())
            .unwrap()
            .encode()
        {
            client.write_all(&[byte]).unwrap();
        }
        client.write_all(REQUEST).unwrap();
        assert_eq!(reply(&mut client), (b'J', expected));
        task.join().unwrap().unwrap();
    });
    service.close(end()).unwrap();
}
#[test]
fn actual_peer_uid_refusal_precedes_frame_and_different_collector_origin() {
    let fixture = Fixture::new();
    let other = Fixture::new();
    let mut service = WorkerReportService::from_runtime(&fixture.runtime);
    service.uid ^= 1; // test-only contrary policy; actual SO_PEERCRED unchanged
    let (mut client, server) = fixture.sockets();
    let error = service.handle(server, &other.collector).unwrap_err();
    assert!(matches!(error, WorkerReportError::Peer));
    assert_eq!(
        reply(&mut client),
        (b'E', b"Worker peer identity is not authorized".to_vec())
    );
    service.close(end()).unwrap();
}
#[test]
fn malformed_and_oversized_purpose_frames_refuse_without_engine_or_storage() {
    let fixture = Fixture::new();
    for (kind, bytes) in [
        (b'T', b"{".to_vec()),
        (b'G', REQUEST.to_vec()),
        (b'T', vec![b' '; 4097]),
        (
            b'T',
            br#"{"v":1,"v":1,"action":"command-failures","employee_ids":[]}"#.to_vec(),
        ),
    ] {
        let service = WorkerReportService::from_runtime(&fixture.runtime);
        let (mut client, server) = fixture.sockets();
        std::thread::scope(|scope| {
            let task = scope.spawn(|| service.handle(server, &fixture.collector));
            send(&mut client, kind, &bytes);
            assert_eq!(
                reply(&mut client),
                (b'E', b"TELEMETRY_REPORT_REFUSED".to_vec())
            );
            assert!(task.join().unwrap().is_err());
        });
        service.close(end()).unwrap();
    }
    assert!(!fixture.root.join("command-telemetry").exists());
}
#[test]
fn transport_max_refuses_header_before_payload_and_eof_closes_without_a_frame() {
    let fixture = Fixture::new();
    for oversized in [true, false] {
        let service = WorkerReportService::from_runtime(&fixture.runtime);
        let (mut client, server) = fixture.sockets();
        let mut header = [0; HEADER_BYTES];
        header[0] = b'T';
        header[1..].copy_from_slice(&if oversized {
            (MAX_FRAME as u32 + 1).to_be_bytes()
        } else {
            3u32.to_be_bytes()
        });
        client.write_all(&header).unwrap();
        if !oversized {
            client.shutdown(std::net::Shutdown::Write).unwrap();
        }
        assert!(service.handle(server, &fixture.collector).is_err());
        if oversized {
            assert_eq!(
                reply(&mut client),
                (b'E', b"Worker frame is too large".to_vec())
            );
        } else {
            let mut byte = [0];
            assert_eq!(client.read(&mut byte).unwrap(), 0);
        }
        service.close(end()).unwrap();
    }
}
#[test]
fn actual_close_failure_is_latched_after_consuming_descriptor_and_preserves_primary() {
    let fixture = Fixture::new();
    let service = WorkerReportService::from_runtime(&fixture.runtime);
    let (mut client, server) = fixture.sockets();
    send(&mut client, b'T', b"{}");
    CLOSE_REFUSAL.with(|flag| flag.set(true));
    let error = service.handle(server, &fixture.collector).unwrap_err();
    assert!(matches!(error, WorkerReportError::Finalization { .. }));
    assert_eq!(
        reply(&mut client),
        (b'E', b"TELEMETRY_REPORT_REFUSED".to_vec())
    );
    let mut end_of_stream = [0];
    assert_eq!(client.read(&mut end_of_stream).unwrap(), 0);
    assert!(service.close(end()).is_err());
    assert!(
        service.close(end()).is_err(),
        "no retry forgives refused checked close"
    );
}
fn wait_for_control_records(service: &WorkerReportService, count: usize) {
    let until = end();
    loop {
        if service.records.try_lock().is_ok_and(|records| {
            records.len() == count && records.iter().all(|record| record.control_ready())
        }) {
            return;
        }
        assert!(
            Instant::now() < until,
            "actual registered descriptor preparation reached"
        );
        std::thread::sleep(Duration::from_millis(1));
    }
}
#[test]
fn real_registered_handlers_keep_connection_cap_until_all_owned_sockets_are_closed() {
    let fixture = Fixture::new();
    let service = WorkerReportService::from_runtime(&fixture.runtime);
    std::thread::scope(|scope| {
        let mut clients = Vec::new();
        let mut tasks = Vec::new();
        for _ in 0..fixture.runtime.connection_limit() {
            let (mut client, server) = fixture.sockets();
            client.write_all(b"T").unwrap(); // incomplete admitted frame
            clients.push(client);
            let held = &service;
            let collector = &fixture.collector;
            tasks.push(scope.spawn(move || held.handle(server, collector)));
        }
        wait_for_control_records(&service, fixture.runtime.connection_limit());
        let (mut rejected, server) = fixture.sockets();
        assert!(matches!(
            service.handle(server, &fixture.collector),
            Err(WorkerReportError::Stopping)
        ));
        let mut byte = [0];
        assert_eq!(rejected.read(&mut byte).unwrap(), 0);
        service.close(end()).unwrap();
        for task in tasks {
            assert!(task.join().unwrap().is_err());
        }
        for mut client in clients {
            assert_eq!(client.read(&mut byte).unwrap(), 0);
        }
    });
    assert!(service.records.lock().unwrap().is_empty());
    service.close(end()).unwrap();
}
struct CloseRelease(Arc<crate::captured_client::test_hooks::Gate>);
impl Drop for CloseRelease {
    fn drop(&mut self) {
        self.0.released.store(true, Ordering::Release);
    }
}
#[test]
fn expired_actual_first_stop_cannot_renew_budget_for_an_owned_checked_finalizer() {
    let fixture = Fixture::new();
    let service = WorkerReportService::from_runtime(&fixture.runtime);
    let gate = Arc::new(crate::captured_client::test_hooks::Gate::default());
    let (mut client, server) = fixture.sockets();
    send(&mut client, b'T', REQUEST);
    std::thread::scope(|scope| {
        let release = CloseRelease(gate.clone());
        let owned = gate.clone();
        let held = &service;
        let collector = &fixture.collector;
        let task = scope.spawn(move || {
            CLOSE_GATE.with(|slot| *slot.borrow_mut() = Some(owned));
            held.handle(server, collector)
        });
        assert_eq!(reply(&mut client).0, b'J');
        let until = end();
        while !gate.entered.load(Ordering::Acquire) {
            assert!(Instant::now() < until);
            std::thread::sleep(Duration::from_millis(1));
        }
        service.engine.expire_stop_for_owned_test();
        let start = Instant::now();
        assert!(
            service
                .close(Instant::now() + Duration::from_secs(2))
                .is_err()
        );
        assert!(start.elapsed() < Duration::from_millis(500));
        assert_eq!(
            service.records.lock().unwrap().len(),
            1,
            "actual unfinished close owner retained"
        );
        drop(release);
        task.join().unwrap().unwrap();
    });
    // Only this transport is now settled; no global broker or storage ACK.
    service.close(end()).unwrap();
}
#[test]
fn checked_close_refusal_before_admission_latches_even_on_an_already_closed_service() {
    let fixture = Fixture::new();
    let service = WorkerReportService::from_runtime(&fixture.runtime);
    service.close(end()).unwrap();
    let (mut client, server) = fixture.sockets();
    CLOSE_REFUSAL.with(|flag| flag.set(true));
    assert!(matches!(
        service.handle(server, &fixture.collector),
        Err(WorkerReportError::Finalization { .. })
    ));
    let mut byte = [0];
    assert_eq!(
        client.read(&mut byte).unwrap(),
        0,
        "actual descriptor was consumed before injected refusal"
    );
    assert!(
        service.close(end()).is_err(),
        "pre-admission checked-close refusal cannot become a later successful close"
    );
    assert!(
        service.close(end()).is_err(),
        "repeated close cannot erase consumed uncertainty"
    );
}
#[test]
fn cap_refusal_close_failure_survives_settlement_of_every_previously_admitted_socket() {
    for fail_close in [false, true] {
        let weak = {
            let fixture = Fixture::new();
            let service = WorkerReportService::from_runtime(&fixture.runtime);
            let weak = Arc::downgrade(&service.engine);
            let mut owned = Vec::new();
            for _ in 0..service.limit {
                let (client, server) = fixture.sockets();
                owned.push((client, service.admit(server).unwrap()));
            }
            let (mut client, server) = fixture.sockets();
            CLOSE_REFUSAL.with(|flag| flag.set(fail_close));
            let refused = service.handle(server, &fixture.collector);
            assert_eq!(
                matches!(refused, Err(WorkerReportError::Finalization { .. })),
                fail_close
            );
            assert!(refused.is_err());
            assert_eq!(client.read(&mut [0]).unwrap(), 0);
            if fail_close {
                let count = service.records.lock().unwrap().len();
                let (mut client, server) = fixture.sockets();
                assert!(matches!(
                    service.admit(server),
                    Err(WorkerReportError::Unconfirmed)
                ));
                assert_eq!(client.read(&mut [0]).unwrap(), 0);
                assert_eq!(service.records.lock().unwrap().len(), count);
            }
            for (mut client, record) in owned {
                send(&mut client, b'T', REQUEST);
                let _operation = record.run(&service, &fixture.collector);
                assert!(
                    record.finished(),
                    "every actual accepted owner was finalized"
                );
            }
            assert_eq!(service.close(end()).is_err(), fail_close);
            assert_eq!(service.close(end()).is_err(), fail_close);
            drop(service);
            weak
        };
        assert_eq!(
            weak.upgrade().is_some(),
            fail_close,
            "only unconfirmed cap-refusal close keeps the actual service origin"
        );
    }
}
#[test]
fn refused_close_retains_exact_origin_while_successful_refusal_does_not_quarantine_it() {
    for fail_close in [false, true] {
        let weak = {
            let fixture = Fixture::new();
            let service = WorkerReportService::from_runtime(&fixture.runtime);
            let weak = Arc::downgrade(&service.engine);
            service.close(end()).unwrap();
            let (_client, server) = fixture.sockets();
            CLOSE_REFUSAL.with(|flag| flag.set(fail_close));
            assert!(service.handle(server, &fixture.collector).is_err());
            if !fail_close {
                service.close(end()).unwrap();
            }
            drop(service);
            weak
        };
        assert_eq!(
            weak.upgrade().is_some(),
            fail_close,
            "only unconfirmed native close keeps the actual service origin"
        );
    }
}

#[test]
fn direct_drop_of_poisoned_empty_registry_keeps_actual_origin_without_a_close_call() {
    for poison in [false, true] {
        let weak = {
            let fixture = Fixture::new();
            let service = WorkerReportService::from_runtime(&fixture.runtime);
            let weak = Arc::downgrade(&service.engine);
            if poison {
                poison_empty_registry(&service);
            }
            // No intervening API observes or latches poison on our behalf.
            drop(service);
            weak
        };
        assert_eq!(weak.upgrade().is_some(), poison);
    }
}

fn poison_empty_registry(service: &WorkerReportService) {
    assert!(
        std::panic::catch_unwind(|| {
            let _guard = service.records.lock().unwrap();
            panic!("owned empty report registry poison");
        })
        .is_err()
    );
}
