use crate::support::*;
use reverie_worker_client::control::{Action, call};
use std::{
    io::Read,
    time::{Duration, Instant},
};

#[test]
fn fixed_library_controls_use_the_existing_wire_and_close_before_returning_data() {
    for (action, name) in [
        (Action::Status, "status"),
        (Action::ProviderHealth, "provider-health"),
        (Action::StorageStatus, "storage-status"),
        (Action::StopLaptops, "stop-laptops"),
    ] {
        let tree = Tree::new();
        let path = tree.socket.clone();
        let client = std::thread::spawn(move || {
            call(&path, action, Instant::now() + Duration::from_secs(1))
        });
        let mut broker = tree.accept();
        assert_eq!(
            receive(&mut broker),
            (b'C', format!("{{\"action\":\"{name}\"}}").into_bytes())
        );
        let raw = b"{ \"success\": false, \"message\": \"DATA ONLY\" }";
        send(&mut broker, b'J', raw);
        let reply = client.join().unwrap().unwrap();
        assert_eq!(reply.as_bytes(), raw);
        assert_eq!(broker.read(&mut [0]).unwrap(), 0);
        tree.no_connection();
    }
}

#[test]
fn lost_library_stop_reply_never_reconnects_or_replays_the_effect() {
    let tree = Tree::new();
    let path = tree.socket.clone();
    let client = std::thread::spawn(move || {
        call(
            &path,
            Action::StopLaptops,
            Instant::now() + Duration::from_secs(1),
        )
    });
    let mut broker = tree.accept();
    assert_eq!(
        receive(&mut broker),
        (b'C', br#"{"action":"stop-laptops"}"#.to_vec())
    );
    drop(broker);
    let error = client.join().unwrap().unwrap_err();
    assert_eq!(error.message(), "Worker connection closed");
    tree.no_connection();
}

#[test]
fn library_fragmented_reply_cannot_extend_the_original_deadline() {
    use std::io::Write;
    let tree = Tree::new();
    let path = tree.socket.clone();
    let end = Instant::now() + Duration::from_millis(150);
    let client = std::thread::spawn(move || call(&path, Action::Status, end));
    let mut broker = tree.accept();
    receive(&mut broker);
    broker.write_all(b"J\0").unwrap();
    let error = client.join().unwrap().unwrap_err();
    assert_eq!(error.message(), "Private worker deadline exceeded");
    assert!(Instant::now() < end + Duration::from_secs(1));
    assert_eq!(broker.read(&mut [0]).unwrap(), 0);
    tree.no_connection();
}

#[test]
fn library_rebound_endpoint_and_invalid_responses_never_return_reply_data() {
    use std::os::unix::{fs::PermissionsExt, net::UnixListener};
    for case in 0..4 {
        let tree = Tree::new();
        let path = tree.socket.clone();
        let client = std::thread::spawn(move || {
            call(
                &path,
                Action::ProviderHealth,
                Instant::now() + Duration::from_secs(1),
            )
        });
        let mut broker = tree.accept();
        receive(&mut broker);
        match case {
            0 => send(&mut broker, b'E', b"refused"),
            1 => send(&mut broker, b'J', b"\xff"),
            2 => {
                std::fs::rename(&tree.socket, tree.root.join("original.sock")).unwrap();
                let replacement = UnixListener::bind(&tree.socket).unwrap();
                std::fs::set_permissions(&tree.socket, std::fs::Permissions::from_mode(0o600))
                    .unwrap();
                send(&mut broker, b'J', b"{}");
                assert!(client.join().unwrap().is_err());
                drop(replacement);
                continue;
            }
            _ => {
                use std::io::Write;
                broker.write_all(&[b'J', 0, 4, 0, 1]).unwrap();
            }
        }
        assert!(client.join().unwrap().is_err());
        assert_eq!(broker.read(&mut [0]).unwrap(), 0);
        tree.no_connection();
    }
}

#[test]
fn expired_library_deadline_and_nonprivate_endpoint_refuse_before_a_request() {
    use std::os::unix::fs::PermissionsExt;
    let tree = Tree::new();
    assert!(call(&tree.socket, Action::Status, Instant::now()).is_err());
    tree.no_connection();
    std::fs::set_permissions(&tree.socket, std::fs::Permissions::from_mode(0o660)).unwrap();
    assert!(
        call(
            &tree.socket,
            Action::Status,
            Instant::now() + Duration::from_secs(1)
        )
        .is_err()
    );
    tree.no_connection();
}
