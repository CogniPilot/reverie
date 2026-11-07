//! The actual live report executes before the next receipt/X. All inherited
//! stderr descriptors belong only to separately spawned exact-one test cases.
use super::*;
use std::process::{Command, Stdio};
const CASE: &str =
    "worker_laptop::tests::existing_viewer::transport::diagnostic::owned_diagnostic_entry";
#[test]
fn owned_diagnostic_entry() {
    let Ok(mode) = std::env::var("REVERIE_RELAY_DIAGNOSTIC_CASE") else {
        return;
    };
    assert!(matches!(mode.as_str(), "regular" | "full"));
    let fixture = Fixture::employee("created-viewer-echo");
    let service = Arc::new(WorkerReportService::from_runtime(fixture.runtime()));
    let (mut client, connection, hold) = accepted(&fixture, &service, "opencode");
    let (existing, path) = retained_with_path(&fixture, &connection);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, b"19").unwrap();
    let viewer = started(&fixture, &existing, &connection);
    let mut relay = connection
        .begin_viewer_relay(fixture.runtime(), &viewer)
        .unwrap();
    send(&mut client, b'R', b"[100,35]");
    // The original sealed inspection has a noncanonical CID. Its resize query
    // is Unavailable, so the real fixed diagnostic is due in this SAME step.
    if mode == "full" {
        assert!(
            relay.step().is_err(),
            "delivery failure must escape before receipt/X"
        );
        assert_eq!(receive(&mut client).0, b'E');
        assert!(relay.step().is_err());
    } else {
        assert!(matches!(relay.step().unwrap(), ViewerRelayEvent::Progress));
        let report = fs::read(std::env::var_os("REVERIE_RELAY_DIAGNOSTIC_FILE").unwrap()).unwrap();
        assert_eq!(report,b"Reverie worker: terminal resize to 100x35 unconfirmed (UNAVAILABLE); last observed none\n");
        // Reporting has already completed before this original grace permits X.
        std::thread::scope(|scope| {
            let task = scope.spawn(|| run(relay, &fixture));
            assert_eq!(receive(&mut client), (b'X', b"19".to_vec()));
            assert!(matches!(task.join().unwrap(),ViewerRelayEnd::Receipt(bytes) if bytes==b"19"));
        });
    }
    assert!(
        fixture
            .runtime()
            .laptop_viewer_status(&viewer)
            .unwrap()
            .is_none()
    );
    assert!(fixture.runtime().reclaim_existing_relay(&existing).is_err());
    assert!(StorageLease::acquire_migration(&fixture.source, &sid()).is_err());
    cleanup_component(&fixture, &existing, connection, hold, &service);
}
fn execute(mode: &str, stderr: Stdio, path: Option<&Path>) {
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .args(["--exact", CASE, "--test-threads=1", "--nocapture"])
        .env("REVERIE_RELAY_DIAGNOSTIC_CASE", mode)
        .stderr(stderr)
        .stdout(Stdio::piped());
    if let Some(path) = path {
        command.env("REVERIE_RELAY_DIAGNOSTIC_FILE", path);
    }
    let mut child = command.spawn().unwrap();
    let end = Instant::now() + Duration::from_secs(15);
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if Instant::now() >= end {
            child.kill().unwrap();
            child.wait().unwrap();
            panic!("owned diagnostic case exceeded finite setup/relay bound");
        }
        std::thread::sleep(Duration::from_millis(5));
    };
    let output = child.wait_with_output().unwrap();
    assert!(
        status.success(),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    assert!(
        String::from_utf8_lossy(&output.stdout).contains("test result: ok. 1 passed; 0 failed;")
    );
}
#[test]
fn actual_resize_report_precedes_x_and_full_stderr_propagates_failure_instead_of_receipt_credit() {
    if crate::test_process::isolate_case(
        "worker_laptop::tests::existing_viewer::transport::diagnostic::actual_resize_report_precedes_x_and_full_stderr_propagates_failure_instead_of_receipt_credit",
    ) {
        return;
    }
    let nonce = reverie_store::worker_storage::instruction_temporary_name().unwrap();
    let path = std::env::temp_dir().join(nonce);
    let output = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .unwrap();
    execute("regular", Stdio::from(output), Some(&path));
    fs::remove_file(path).unwrap();
    let (_reader, mut writer) = UnixStream::pair().unwrap();
    writer.set_nonblocking(true).unwrap();
    loop {
        match writer.write(&[b'f'; 4096]) {
            Ok(n) => assert!(n > 0),
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => break,
            Err(error) => panic!("{error}"),
        }
    }
    writer.set_nonblocking(false).unwrap();
    let observer = writer.try_clone().unwrap();
    execute(
        "full",
        Stdio::from(std::os::fd::OwnedFd::from(writer)),
        None,
    );
    assert_eq!(
        nix::fcntl::fcntl(&observer, nix::fcntl::FcntlArg::F_GETFL).unwrap() & libc::O_NONBLOCK,
        0
    );
}
