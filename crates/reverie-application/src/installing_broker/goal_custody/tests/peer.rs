//! Same host UID is insufficient: use a real newly unshared mount namespace
//! and a newly connected socket whose kernel peer is the actual child.
use super::*;
use std::{
    os::unix::net::UnixListener,
    process::{Command, Stdio},
};

#[test]
fn actual_same_uid_g_peer_in_foreign_mount_namespace_is_refused() {
    const SOCKET: &str = "REVERIE_GOAL_PEER_NS_SOCKET";
    if let Some(path) = std::env::var_os(SOCKET) {
        let mut stream = UnixStream::connect(path).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        send(&mut stream, br#"{"action":"goal-custody"}"#);
        let (kind, bytes) = reply(&mut stream);
        assert_eq!(kind, b'E', "{}", String::from_utf8_lossy(&bytes));
        assert_eq!(bytes, b"Goal custody caller refused");
        return;
    }
    crate::test_process::owning_case!(actual_same_uid_g_peer_in_foreign_mount_namespace_is_refused);
    let fixture = Fixture::new();
    let socket = fixture.tree.root.join("control/peer.sock");
    let listener = UnixListener::bind(&socket).unwrap();
    listener.set_nonblocking(true).unwrap();
    let name = concat!(
        module_path!(),
        "::actual_same_uid_g_peer_in_foreign_mount_namespace_is_refused"
    );
    let name = name.strip_prefix("reverie_application::").unwrap_or(name);
    let mut child = Command::new("unshare")
        .args([
            "--user",
            "--map-current-user",
            "--mount",
            "--fork",
            "--kill-child=TERM",
        ])
        .arg(std::env::current_exe().unwrap())
        .args(["--exact", name, "--test-threads=1"])
        .env(SOCKET, &socket)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let end = end();
    let server = loop {
        match listener.accept() {
            Ok((stream, _)) => break stream,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
            Err(error) => panic!("owned socket accept: {error}"),
        }
        if let Some(status) = child.try_wait().unwrap() {
            let output = child.wait_with_output().unwrap();
            panic!(
                "owned namespace child exited {status}: {}{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
        }
        assert!(
            Instant::now() < end,
            "actual child must connect in its own namespace"
        );
        std::thread::sleep(Duration::from_millis(2));
    };
    let connection = fixture.accept(server);
    assert_eq!(
        connection.peer().uid(),
        fixture
            .broker
            .configuration()
            .unwrap()
            .envelope()
            .base()
            .ids()
            .uid()
    );
    assert_ne!(connection.peer().pid(), std::process::id() as i32);
    let closed = fixture.broker.handle_goal_custody(connection).unwrap();
    assert_eq!(
        closed.primary_error_code(),
        Some("Goal custody caller refused")
    );
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("1 passed; 0 failed"));
    fixture.close();
}
