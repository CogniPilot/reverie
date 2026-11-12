use super::*;
mod docker;
use std::{
    collections::BTreeMap,
    fs,
    io::Read,
    os::unix::{
        fs::{DirBuilderExt, PermissionsExt},
        net::{UnixListener, UnixStream},
    },
    path::PathBuf,
    process::{Child, Command},
    sync::OnceLock,
};
const SID: &str = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
static PROGRAM: OnceLock<PathBuf> = OnceLock::new();
fn program() -> &'static Path {
    PROGRAM.get_or_init(|| {
        let root = std::env::temp_dir().join(format!(
            "viewer-program-{}",
            crate::resource_facts::fresh_owner_nonce().unwrap().as_str()
        ));
        fs::create_dir(&root).unwrap();
        fs::write(root.join("child.rs"), include_str!("child.rs")).unwrap();
        let binary = root.join("child");
        assert!(
            Command::new("rustc")
                .args(["--edition=2024", "-o"])
                .arg(&binary)
                .arg(root.join("child.rs"))
                .status()
                .unwrap()
                .success()
        );
        binary
    })
}
struct Fixture {
    root: PathBuf,
    service: Arc<WorkerViewerService>,
    agent: Child,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "vw-{}",
            &crate::resource_facts::fresh_owner_nonce().unwrap().as_str()[..12]
        ));
        fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
        fs::write(root.join("cid"), "c".repeat(64)).unwrap();
        fs::write(root.join("company.json"), serde_json::to_vec(&serde_json::json!({"employees":[{"id":"11111111-2222-4333-8444-555555555555", "sessionId":SID,"sessionGeneration":1,"owner":null,"desiredRunning":true}]})).unwrap()).unwrap();
        let config = serde_json::json!({"version":1,"deployment":"viewer","image":format!("sha256:{}","a".repeat(64)),"serverContainer":"viewer-server","socket":root.join("broker.sock"),"stateRoot":root.join("state"),"companyFile":root.join("company.json"),"companyRoot":root.join("company"),"scratchRoot":root.join("scratch"),"apiSocketRoot":root.join("api"),"budgetMode":"pool","uid":crate::native::uid(),"gid":100,"memoryMiB":0,"poolMemoryMiB":4096,"poolTasksMax":1024,"cgroupParent":"reverie-workers.slice","pidsLimit":128,"cpus":0,"maxWorkers":4,"mounts":[{"source":root.join("work"),"destination":"/workspace","readOnly":false}],"maintenanceSessions":[]});
        let source = root.join("broker.json");
        fs::write(&source, serde_json::to_vec(&config).unwrap()).unwrap();
        fs::set_permissions(&source, fs::Permissions::from_mode(0o600)).unwrap();
        let environment = BTreeMap::from([
            ("VIEWER_FIXTURE_ROOT".into(), root.clone().into_os_string()),
            ("PATH".into(), std::env::var_os("PATH").unwrap()),
        ]);
        let engine =
            EngineBootstrap::from_service(program().as_os_str(), environment, root.clone())
                .unwrap();
        let service = WorkerViewerService::new(&source, engine).unwrap();
        let agent = Command::new(program())
            .arg("--agent")
            .env("VIEWER_FIXTURE_ROOT", &root)
            .spawn()
            .unwrap();
        Self {
            root,
            service,
            agent,
        }
    }
    fn raw(&self, attach: bool, sid: &str) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({"sessionId":sid,"cwd":"/workspace","command":"MUST NEVER EXECUTE","env":{},"cols":80,"rows":24,"attachOnly":attach})).unwrap()
    }
    fn model_running(&mut self) -> bool {
        self.agent.try_wait().unwrap().is_none() && !self.root.join("agent-stop").exists()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self.agent.kill();
        let _ = self.agent.wait();
    }
}
fn receive(stream: &mut UnixStream) -> (u8, Vec<u8>) {
    let mut header = [0; 5];
    stream.read_exact(&mut header).unwrap();
    let header = reverie_core::worker_wire::WorkerFrameHeader::decode(header);
    let mut raw = vec![0; header.payload_length() as usize];
    stream.read_exact(&mut raw).unwrap();
    (header.kind(), raw)
}
fn until(stream: &mut UnixStream, expected: &[u8]) -> Vec<u8> {
    let mut text = Vec::new();
    while !text.windows(expected.len()).any(|bytes| bytes == expected) {
        let (kind, raw) = receive(stream);
        assert_eq!(kind, b'O', "{raw:?}");
        text.extend_from_slice(&raw);
    }
    text
}
#[test]
fn real_pty_unicode_resize_disconnect_and_reattach_preserve_running_agent() {
    if crate::test_process::isolate_case(
        "worker_viewer::tests::real_pty_unicode_resize_disconnect_and_reattach_preserve_running_agent",
    ) {
        return;
    }
    let mut fixture = Fixture::new();
    let pid = fixture.agent.id();
    for pass in 0..2 {
        let (mut client, mut server) = UnixStream::pair().unwrap();
        client
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let service = fixture.service.clone();
        let task = std::thread::spawn(move || service.handle(&mut server));
        broker_listener::write_frame(&mut client, b'J', &fixture.raw(true, SID)).unwrap();
        until(&mut client, "READY › ──".as_bytes());
        broker_listener::write_frame(&mut client, b'R', b"[101,31]").unwrap();
        broker_listener::write_frame(&mut client, b'I', b"S").unwrap();
        until(&mut client, b"31 101");
        drop(client);
        assert!(task.join().unwrap().is_err());
        assert!(
            fixture.model_running(),
            "disconnect {pass} must not forward EOF to agent"
        );
        assert_eq!(fixture.agent.id(), pid);
    }
    let trace = fs::read_to_string(fixture.root.join("trace")).unwrap();
    assert!(
        trace
            .lines()
            .all(|line| line.starts_with("inspect\0") || line.starts_with("exec\0"))
    );
    assert!(!trace.contains("MUST NEVER EXECUTE"));
    assert!(fixture.service.retained.lock().unwrap().is_empty());
}
#[test]
fn ordinary_control_and_unknown_employee_refuse_before_any_engine_command() {
    let fixture = Fixture::new();
    for (kind, raw) in [
        (b'C', b"{}".to_vec()),
        (b'L', b"{}".to_vec()),
        (b'J', fixture.raw(false, SID)),
        (
            b'J',
            fixture.raw(true, "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee"),
        ),
    ] {
        let (mut client, mut server) = UnixStream::pair().unwrap();
        broker_listener::write_frame(&mut client, kind, &raw).unwrap();
        assert!(fixture.service.handle(&mut server).is_err());
    }
    assert!(!fixture.root.join("trace").exists());
}
#[test]
fn malformed_running_status_never_grants_attach() {
    let fixture = Fixture::new();
    for running in ["\"false\"", "1", "null", "false"] {
        fs::write(fixture.root.join("running"), running).unwrap();
        let (mut client, mut server) = UnixStream::pair().unwrap();
        broker_listener::write_frame(&mut client, b'J', &fixture.raw(true, SID)).unwrap();
        assert!(fixture.service.handle(&mut server).is_err());
    }
    let trace = fs::read_to_string(fixture.root.join("trace")).unwrap();
    assert!(trace.lines().all(|line| line.starts_with("inspect\0")));
}
#[test]
fn revocation_refuses_next_input_and_closes_only_owned_attach() {
    if crate::test_process::isolate_case(
        "worker_viewer::tests::revocation_refuses_next_input_and_closes_only_owned_attach",
    ) {
        return;
    }
    let mut fixture = Fixture::new();
    let (mut client, mut server) = UnixStream::pair().unwrap();
    client
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let service = fixture.service.clone();
    let task = std::thread::spawn(move || service.handle(&mut server));
    broker_listener::write_frame(&mut client, b'J', &fixture.raw(true, SID)).unwrap();
    until(&mut client, "READY › ──".as_bytes());
    let company = fixture.root.join("company.json");
    let mut value: serde_json::Value =
        serde_json::from_slice(&fs::read(&company).unwrap()).unwrap();
    value["employees"][0]["desiredRunning"] = false.into();
    fs::write(company, serde_json::to_vec(&value).unwrap()).unwrap();
    broker_listener::write_frame(&mut client, b'I', b"MUST NOT REACH REVOKED AGENT").unwrap();
    let error = task.join().unwrap().unwrap_err();
    assert_eq!(error.code, "WORKER_VIEWER_TARGET_CHANGED");
    assert!(fixture.model_running());
    assert!(fixture.service.retained.lock().unwrap().is_empty());
}
#[test]
fn stale_socket_recovery_preserves_live_foreign_and_non_socket_entries() {
    let fixture = Fixture::new();
    let path = fixture.root.join("viewer.sock");
    let owner =
        socket::Ownership::acquire(&fixture.service.configuration().unwrap(), &path).unwrap();
    let listener = UnixListener::bind(&path).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    assert!(owner.clear_stale().is_err());
    assert!(path.exists());
    drop(listener);
    owner.clear_stale().unwrap();
    assert!(!path.exists());
    fs::write(&path, b"keep original bytes").unwrap();
    assert!(owner.clear_stale().is_err());
    assert_eq!(fs::read(&path).unwrap(), b"keep original bytes");
    owner.finish().unwrap();
}
