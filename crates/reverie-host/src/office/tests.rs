//! Owned synthetic sockets/files only. No engine, provider, installed company,
//! grant or container is touched by these actual transport controls.
#[path = "construction_tests.rs"]
mod construction;
#[path = "native_tests.rs"]
mod native;
use super::*;
use crate::engine_metadata::EngineBootstrap;
use reverie_core::{
    resources::{BudgetMode, CpuQuota, ResourcePolicy},
    worker_schema::{WorkerBase, WorkerIds},
};
use std::{
    fs,
    io::{Read, Write},
    net::TcpListener,
    os::unix::{fs::PermissionsExt, net::UnixStream},
    path::Path,
    sync::mpsc,
};
const SID: &str = "11111111-1111-4111-8111-111111111111";
struct Fixture {
    root: PathBuf,
    service: OfficeService,
    runtime: WorkerRuntime,
    close_ok: bool,
}
impl Fixture {
    fn new(address: SocketAddr) -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let root = std::env::temp_dir().join(format!(
            "of-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        fs::create_dir(root.join("console")).unwrap();
        fs::write(
            root.join("console/.env"),
            "REVERIE_USERNAME=fixture\nREVERIE_PASSWORD=synthetic-only\n",
        )
        .unwrap();
        fs::write(root.join("console/hook-secret"), " synthetic-hook\n").unwrap();
        let base = WorkerBase::try_new(
            "fixture".into(),
            "fixture-server".into(),
            format!("sha256:{}", "a".repeat(64)),
            WorkerIds::try_new(1000, 1000).unwrap(),
            4,
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
        let bootstrap = EngineBootstrap::from_service(
            crate::engine_metadata::tests::program().as_os_str(),
            BTreeMap::new(),
            fs::canonicalize(std::env::temp_dir()).unwrap(),
        )
        .unwrap();
        let runtime = WorkerRuntime::new(InstalledWorkerEngine::new(bootstrap), &base);
        let service = OfficeService::from_runtime(&runtime, root.clone(), address.ip()).unwrap();
        service.company.address.update_fixed(address).unwrap();
        Self {
            root,
            service,
            runtime,
            close_ok: true,
        }
    }
    fn bind(&self, name: &str) -> OfficePhone {
        self.service
            .bind(self.root.join(name), ProfileSessionId::parse(SID).unwrap())
            .unwrap()
    }
    fn request(
        &self,
        name: &str,
        method: &str,
        target: &str,
        body: &[u8],
        headers: &str,
    ) -> Vec<u8> {
        let mut stream = UnixStream::connect(self.root.join(name).join("office.sock")).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        write!(
            stream,
            "{method} {target} HTTP/1.1\r\nHost: forged\r\nContent-Length: {}\r\n{headers}\r\n",
            body.len()
        )
        .unwrap();
        stream.write_all(body).unwrap();
        let mut response = Vec::new();
        stream.read_to_end(&mut response).unwrap();
        response
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        assert_eq!(
            self.service
                .close(Instant::now() + Duration::from_secs(2))
                .is_ok(),
            self.close_ok
        );
        self.runtime
            .close(Instant::now() + Duration::from_secs(2))
            .unwrap();
        fs::remove_dir_all(&self.root).unwrap();
    }
}
struct Upstream {
    address: SocketAddr,
    receiver: mpsc::Receiver<Vec<u8>>,
    thread: Option<JoinHandle<()>>,
}
impl Upstream {
    fn start(response: &'static [u8]) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let (sender, receiver) = mpsc::channel();
        let thread = std::thread::spawn(move || {
            let mut stream = accept_upstream(&listener);
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut request = Vec::new();
            let mut byte = [0];
            while !request.ends_with(b"\r\n\r\n") {
                stream.read_exact(&mut byte).unwrap();
                request.push(byte[0]);
            }
            let header = String::from_utf8(request.clone()).unwrap();
            let length = header
                .lines()
                .find_map(|line| {
                    line.to_ascii_lowercase()
                        .strip_prefix("content-length:")
                        .map(str::trim)
                        .map(str::to_owned)
                })
                .unwrap()
                .parse::<usize>()
                .unwrap();
            let mut body = vec![0; length];
            stream.read_exact(&mut body).unwrap();
            request.extend(body);
            sender.send(request).unwrap();
            stream.write_all(response).unwrap();
        });
        Self {
            address,
            receiver,
            thread: Some(thread),
        }
    }
    fn captured(&mut self) -> String {
        let request = self.receiver.recv_timeout(Duration::from_secs(5)).unwrap();
        self.thread.take().unwrap().join().unwrap();
        String::from_utf8(request).unwrap()
    }
}
fn accept_upstream(listener: &TcpListener) -> std::net::TcpStream {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        match listener.accept() {
            Ok((stream, _)) => return stream,
            Err(error)
                if error.kind() == io::ErrorKind::WouldBlock && Instant::now() < deadline =>
            {
                std::thread::sleep(Duration::from_millis(5))
            }
            Err(error) => panic!("owned upstream did not accept: {error}"),
        }
    }
}
fn status(response: &[u8]) -> u16 {
    String::from_utf8_lossy(response)
        .split_whitespace()
        .nth(1)
        .unwrap()
        .parse()
        .unwrap()
}
#[test]
fn actual_phone_fixes_identity_strips_guest_credentials_and_hides_upstream_cookie() {
    let mut upstream = Upstream::start(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nSet-Cookie: synthetic-private\r\nConnection: close\r\n\r\n{}");
    let fixture = Fixture::new(upstream.address);
    let phone = fixture.bind("phone");
    let response = fixture.request("phone", "GET", "/api/company", b"", "Authorization: forged\r\nCookie: forged\r\nX-Reverie-Parent-Session: forged\r\nX-Reverie-Service-Token: forged\r\nX-Reverie-Goal-Assertion: forged\r\nX-Reverie-Recovery-Assertion: forged\r\n");
    assert_eq!(
        status(&response),
        200,
        "{}",
        String::from_utf8_lossy(&response)
    );
    let request = upstream.captured().to_ascii_lowercase();
    assert!(request.contains(&format!("x-reverie-parent-session: {SID}")));
    assert!(request.contains("authorization: basic zml4dhvyztpzew50agv0awmtb25seq=="));
    assert!(!request.contains("forged"));
    assert!(!request.contains("cookie:"));
    assert!(!request.contains("x-reverie-service-token"));
    assert!(!request.contains("x-reverie-goal-"));
    assert!(!request.contains("x-reverie-recovery-"));
    assert!(
        !String::from_utf8_lossy(&response)
            .to_ascii_lowercase()
            .contains("set-cookie")
    );
    assert!(response.ends_with(b"{}"));
    fixture
        .service
        .close_phone(&phone, Instant::now() + Duration::from_secs(2))
        .unwrap();
    assert!(!fixture.root.join("phone/office.sock").exists());
}
#[test]
fn actual_hook_checks_fixed_session_and_only_injects_host_secret_after_validation() {
    let mut upstream = Upstream::start(b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n");
    let fixture = Fixture::new(upstream.address);
    let _phone = fixture.bind("phone");
    assert_eq!(
        status(&fixture.request(
            "phone",
            "POST",
            "/api/hook-event",
            b"{\"sessionId\":\"forged\"}",
            ""
        )),
        403
    );
    assert!(matches!(
        upstream.receiver.try_recv(),
        Err(mpsc::TryRecvError::Empty)
    ));
    let body = format!("{{\"sessionId\":\"{SID}\"}}");
    assert_eq!(
        status(&fixture.request(
            "phone",
            "POST",
            "/api/hook-event",
            body.as_bytes(),
            "X-Reverie-Hook-Secret: forged\r\n"
        )),
        204
    );
    let request = upstream.captured().to_ascii_lowercase();
    assert!(request.contains("x-reverie-hook-secret: synthetic-hook"));
    assert!(!request.contains("forged"));
}
#[test]
fn unavailable_named_adapters_and_reserved_paths_never_read_host_credentials_or_forward() {
    let fixture = Fixture::new("127.0.0.1:9".parse().unwrap());
    fs::remove_file(fixture.root.join("console/.env")).unwrap();
    let _phone = fixture.bind("phone");
    for target in [
        "/api/goals",
        "/api/goal-grants/forged",
        "/api/plans/requests/request/credential",
        "/api/plans/requests/request/%63redential/",
        "/api/plans/requests/request/approve",
        "/api/company/employees/11111111-1111-4111-8111-111111111111/reconnect",
        "http://evil.invalid/api/company",
        "/outside",
    ] {
        assert_eq!(
            status(&fixture.request("phone", "POST", target, b"{}", "")),
            403,
            "{target}"
        );
    }
    for target in [
        "/api/ops",
        "/api/host-actions",
        "/api/browser-jobs",
        "/api/command-telemetry/hands",
    ] {
        assert_eq!(
            status(&fixture.request(
                "phone",
                "POST",
                target,
                b"{}",
                "Content-Type: application/json\r\n"
            )),
            503,
            "{target}"
        );
    }
    assert_eq!(
        status(&fixture.request("phone", "POST", "/api/ops?forged=1", b"{}", "")),
        400
    );
}
#[test]
fn dropped_phone_retains_actual_registry_owner_and_shared_stop_closes_its_sockets() {
    let fixture = Fixture::new("127.0.0.1:9".parse().unwrap());
    let phone = fixture.bind("phone");
    drop(phone);
    assert_eq!(fixture.service.offices.lock().unwrap().len(), 1);
    let mut incomplete = UnixStream::connect(fixture.root.join("phone/office.sock")).unwrap();
    incomplete
        .write_all(b"POST /api/company HTTP/1.1\r\n")
        .unwrap();
    fixture.runtime.request_stop();
    assert!(matches!(
        fixture.service.bind(
            fixture.root.join("new"),
            ProfileSessionId::parse(SID).unwrap()
        ),
        Err(OfficeError::Closed)
    ));
    fixture
        .service
        .close(Instant::now() + Duration::from_secs(2))
        .unwrap();
    assert!(!fixture.root.join("phone/office.sock").exists());
    assert!(fixture.service.offices.lock().unwrap().is_empty());
    incomplete
        .set_read_timeout(Some(Duration::from_secs(1)))
        .unwrap();
    let mut byte = [0];
    assert!(matches!(incomplete.read(&mut byte), Ok(0) | Err(_)));
}
#[test]
fn existing_socket_symlink_or_public_directory_is_never_replaced() {
    let fixture = Fixture::new("127.0.0.1:9".parse().unwrap());
    let _phone = fixture.bind("phone");
    let original = fs::symlink_metadata(fixture.root.join("phone/office.sock")).unwrap();
    assert!(
        fixture
            .service
            .bind(
                fixture.root.join("phone"),
                ProfileSessionId::parse(SID).unwrap()
            )
            .is_err()
    );
    use std::os::unix::fs::MetadataExt;
    assert_eq!(
        original.ino(),
        fs::symlink_metadata(fixture.root.join("phone/office.sock"))
            .unwrap()
            .ino()
    );
    std::os::unix::fs::symlink(fixture.root.join("phone"), fixture.root.join("alias")).unwrap();
    assert!(
        fixture
            .service
            .bind(
                fixture.root.join("alias"),
                ProfileSessionId::parse(SID).unwrap()
            )
            .is_err()
    );
    fs::create_dir(fixture.root.join("public")).unwrap();
    fs::set_permissions(
        fixture.root.join("public"),
        fs::Permissions::from_mode(0o755),
    )
    .unwrap();
    assert!(
        fixture
            .service
            .bind(
                fixture.root.join("public"),
                ProfileSessionId::parse(SID).unwrap()
            )
            .is_err()
    );
}
#[test]
fn replacement_socket_survives_close_and_the_failed_owner_is_retained() {
    let mut fixture = Fixture::new("127.0.0.1:9".parse().unwrap());
    let phone = fixture.bind("phone");
    let path = fixture.root.join("phone/office.sock");
    fs::rename(&path, fixture.root.join("phone/original.sock")).unwrap();
    let replacement = std::os::unix::net::UnixListener::bind(&path).unwrap();
    assert!(
        fixture
            .service
            .close_phone(&phone, Instant::now() + Duration::from_secs(2))
            .is_err()
    );
    assert_eq!(fixture.service.offices.lock().unwrap().len(), 1);
    assert!(Path::new(&path).exists());
    drop(replacement);
    // This is an intentionally unresolved owner. Do not have fixture teardown
    // turn that failure into an all-context close success.
    fixture.close_ok = false;
}
fn plan_capability(fixture: &Fixture) -> PathBuf {
    let console = fixture.root.join("console");
    fs::set_permissions(&console, fs::Permissions::from_mode(0o700)).unwrap();
    let caps = console.join("plan-request-capabilities");
    fs::create_dir(&caps).unwrap();
    fs::set_permissions(&caps, fs::Permissions::from_mode(0o700)).unwrap();
    let directory = caps.join(SID);
    fs::create_dir(&directory).unwrap();
    fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).unwrap();
    let path = directory.join("request.json");
    fs::write(
        &path,
        format!(
            "{{\"requestId\":\"request\",\"sessionId\":\"{SID}\",\"nonce\":\"{}\"}}",
            "a".repeat(64)
        ),
    )
    .unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    path
}
#[test]
fn actual_plan_approval_reads_exact_private_capability_and_preserves_handoff() {
    let mut upstream =
        Upstream::start(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}");
    let fixture = Fixture::new(upstream.address);
    let path = plan_capability(&fixture);
    let before = fs::read(&path).unwrap();
    let _phone = fixture.bind("phone");
    let handoff = "{\"handoff\":\"Safe λ handoff\"}";
    let response = fixture.request(
        "phone",
        "POST",
        "/api/plans/requests/request/approve",
        handoff.as_bytes(),
        "X-Reverie-Parent-Session: forged\r\nCookie: forged\r\n",
    );
    assert_eq!(status(&response), 200);
    let request = upstream.captured();
    assert!(request.ends_with(&format!(
        "{{\"handoff\":\"Safe λ handoff\",\"nonce\":\"{}\"}}",
        "a".repeat(64)
    )));
    assert!(!request.contains("forged"));
    assert_eq!(fs::read(path).unwrap(), before);
    assert!(!String::from_utf8_lossy(&response).contains(&"a".repeat(64)));
}
#[test]
fn actual_plan_approval_rejects_bad_custody_and_forged_payload_before_upstream() {
    let fixture = Fixture::new("127.0.0.1:9".parse().unwrap());
    let path = plan_capability(&fixture);
    let before = fs::read(&path).unwrap();
    let _phone = fixture.bind("phone");
    let target = "/api/plans/requests/request/approve";
    let body = b"{\"handoff\":\"Safe\"}";
    for bad in [
        b"{\"handoff\":\"Safe\",\"nonce\":\"forged\"}".as_slice(),
        b"{\"handoff\":\"one\",\"handoff\":\"two\"}",
    ] {
        assert_eq!(
            status(&fixture.request("phone", "POST", target, bad, "")),
            403
        );
    }
    assert_eq!(
        status(&fixture.request("phone", "POST", &format!("{target}?forged=1"), body, "")),
        403
    );
    fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
    assert_eq!(
        status(&fixture.request("phone", "POST", target, body, "")),
        403
    );
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    fs::hard_link(&path, fixture.root.join("alias-capability")).unwrap();
    assert_eq!(
        status(&fixture.request("phone", "POST", target, body, "")),
        403
    );
    fs::remove_file(fixture.root.join("alias-capability")).unwrap();
    fs::remove_file(&path).unwrap();
    std::os::unix::fs::symlink(fixture.root.join("console/.env"), &path).unwrap();
    assert_eq!(
        status(&fixture.request("phone", "POST", target, body, "")),
        403
    );
    fs::remove_file(&path).unwrap();
    fs::write(&path, before).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    fs::set_permissions(path.parent().unwrap(), fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(
        status(&fixture.request("phone", "POST", target, body, "")),
        403
    );
}
#[test]
fn unavailable_ops_settles_actual_split_body_before_confirmed_refusal() {
    let fixture = Fixture::new("127.0.0.1:9".parse().unwrap());
    let _phone = fixture.bind("phone");
    let mut stream = UnixStream::connect(fixture.root.join("phone/office.sock")).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_millis(100)))
        .unwrap();
    stream
        .write_all(b"POST /api/ops HTTP/1.1\r\nHost: localhost\r\nContent-Length: 4\r\n\r\n")
        .unwrap();
    let mut byte = [0];
    assert!(
        matches!(stream.read(&mut byte), Err(error) if matches!(error.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut))
    );
    stream.write_all(b"a").unwrap();
    assert!(
        matches!(stream.read(&mut byte), Err(error) if matches!(error.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut))
    );
    stream.write_all(b"bcd").unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let mut response = Vec::new();
    stream.read_to_end(&mut response).unwrap();
    assert_eq!(status(&response), 503);
}
#[test]
fn streamed_event_reaches_employee_before_upstream_eof_and_stop_closes_both_sockets() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let (ended, observed) = mpsc::channel();
    let upstream = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut header = Vec::new();
        let mut byte = [0];
        while !header.ends_with(b"\r\n\r\n") {
            stream.read_exact(&mut byte).unwrap();
            header.push(byte[0]);
        }
        stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\ndata: first\n\n").unwrap();
        let eof = stream.read(&mut byte);
        ended.send(matches!(eof, Ok(0))).unwrap();
    });
    let fixture = Fixture::new(address);
    let _phone = fixture.bind("phone");
    let mut client = UnixStream::connect(fixture.root.join("phone/office.sock")).unwrap();
    client
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    client
        .write_all(b"GET /api/events HTTP/1.1\r\nHost: localhost\r\n\r\n")
        .unwrap();
    let mut response = Vec::new();
    let mut buffer = [0; 4096];
    while !response
        .windows(b"data: first\n\n".len())
        .any(|part| part == b"data: first\n\n")
    {
        let count = client.read(&mut buffer).unwrap();
        assert_ne!(count, 0);
        response.extend_from_slice(&buffer[..count]);
    }
    assert_eq!(status(&response), 200);
    assert!(matches!(
        observed.try_recv(),
        Err(mpsc::TryRecvError::Empty)
    ));
    fixture
        .service
        .close(Instant::now() + Duration::from_secs(2))
        .unwrap();
    let closed = observed.recv_timeout(Duration::from_secs(5));
    upstream.join().unwrap();
    assert!(closed.unwrap());
}
#[test]
fn stop_deadline_does_not_wait_for_a_registry_lock_or_erase_its_owner() {
    let fixture = Fixture::new("127.0.0.1:9".parse().unwrap());
    let _phone = fixture.bind("phone");
    std::thread::scope(|scope| {
        let (ready, is_ready) = mpsc::channel();
        let (release, released) = mpsc::channel();
        let service = &fixture.service;
        let holder = scope.spawn(move || {
            let _held = service.offices.lock().unwrap();
            ready.send(()).unwrap();
            released.recv().unwrap();
        });
        is_ready.recv_timeout(Duration::from_secs(2)).unwrap();
        let (result, observed) = mpsc::channel();
        let closer = scope.spawn(move || {
            result
                .send(service.close(Instant::now() + Duration::from_millis(20)))
                .unwrap();
        });
        let outcome = observed.recv_timeout(Duration::from_secs(2));
        release.send(()).unwrap();
        holder.join().unwrap();
        closer.join().unwrap();
        assert!(matches!(outcome.unwrap(), Err(OfficeError::Unconfirmed)));
    });
    assert_eq!(fixture.service.offices.lock().unwrap().len(), 1);
    fixture
        .service
        .close(Instant::now() + Duration::from_secs(2))
        .unwrap();
}
#[test]
fn runtime_and_spawn_failures_finalize_actual_prepared_socket_owners() {
    for failure in [test_hooks::Failure::Runtime, test_hooks::Failure::Spawn] {
        let fixture = Fixture::new("127.0.0.1:9".parse().unwrap());
        test_hooks::set(failure);
        assert!(
            fixture
                .service
                .bind(
                    fixture.root.join("phone"),
                    ProfileSessionId::parse(SID).unwrap()
                )
                .is_err()
        );
        assert!(fixture.service.offices.lock().unwrap().is_empty());
        assert!(!fixture.root.join("phone/office.sock").exists());
    }
}
#[test]
fn unidentified_post_bind_failures_close_listener_and_retain_the_created_leaf_fence() {
    for failure in [
        test_hooks::Failure::BeforeAnchor,
        test_hooks::Failure::AfterAnchor,
    ] {
        let mut fixture = Fixture::new("127.0.0.1:9".parse().unwrap());
        test_hooks::set(failure);
        let result = fixture.service.bind(
            fixture.root.join("phone"),
            ProfileSessionId::parse(SID).unwrap(),
        );
        assert!(matches!(result, Err(OfficeError::Finalization { .. })));
        assert_eq!(fixture.service.offices.lock().unwrap().len(), 1);
        assert!(fixture.root.join("phone/office.sock").exists());
        assert!(UnixStream::connect(fixture.root.join("phone/office.sock")).is_err());
        assert!(
            fixture
                .service
                .close(Instant::now() + Duration::from_secs(2))
                .is_err()
        );
        fixture.close_ok = false;
    }
}
#[test]
fn failed_spawn_preserves_primary_and_actual_close_failure_without_forgetting_owner() {
    let mut fixture = Fixture::new("127.0.0.1:9".parse().unwrap());
    test_hooks::set(test_hooks::Failure::Spawn);
    crate::native::test_faults::set(None, true);
    let result = fixture.service.bind(
        fixture.root.join("phone"),
        ProfileSessionId::parse(SID).unwrap(),
    );
    assert!(matches!(result, Err(OfficeError::Finalization { .. })));
    assert_eq!(fixture.service.offices.lock().unwrap().len(), 1);
    assert!(!fixture.root.join("phone/office.sock").exists());
    assert!(
        fixture
            .service
            .close(Instant::now() + Duration::from_secs(2))
            .is_err()
    );
    fixture.close_ok = false;
}
