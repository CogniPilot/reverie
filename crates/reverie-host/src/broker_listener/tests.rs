use super::*;
use std::os::unix::fs::{MetadataExt, PermissionsExt, symlink};

fn scratch(name: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!(
        "broker-listener-{name}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(&root).unwrap();
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
    root
}
fn me() -> u32 {
    fs::metadata("/proc/self").unwrap().uid()
}

#[test]
fn directory_is_created_owner_only() {
    let root = scratch("create");
    let socket = root.join("control").join("broker.sock");
    prepare_directory(&socket).unwrap();
    let mode = fs::metadata(root.join("control")).unwrap().mode() & 0o777;
    assert_eq!(mode & 0o077, 0, "mode {mode:o}");
}

#[test]
fn group_accessible_directory_is_refused() {
    let root = scratch("mode");
    let dir = root.join("control");
    fs::create_dir(&dir).unwrap();
    fs::set_permissions(&dir, fs::Permissions::from_mode(0o750)).unwrap();
    let error = prepare_directory(&dir.join("broker.sock")).unwrap_err();
    assert!(matches!(error, ListenerError::DirectoryUnsafe));
    assert_eq!(
        error.message(),
        "Worker socket directory must be owner-only"
    );
}

#[test]
fn symlinked_directory_is_refused() {
    let root = scratch("link");
    let real = root.join("real");
    fs::create_dir(&real).unwrap();
    fs::set_permissions(&real, fs::Permissions::from_mode(0o700)).unwrap();
    symlink(&real, root.join("control")).unwrap();
    let error = prepare_directory(&root.join("control").join("broker.sock")).unwrap_err();
    assert!(matches!(error, ListenerError::DirectoryUnsafe));
}

#[test]
fn foreign_owner_is_refused() {
    let root = scratch("owner");
    let socket = root.join("control").join("broker.sock");
    let error = prepare_directory_as(&socket, me() + 1).unwrap_err();
    assert!(matches!(error, ListenerError::DirectoryUnsafe));
}

#[test]
fn missing_entry_is_clear() {
    let root = scratch("missing");
    clear_stale(&root.join("broker.sock")).unwrap();
}

#[test]
fn non_socket_is_refused_and_kept() {
    let root = scratch("file");
    let path = root.join("broker.sock");
    fs::write(&path, b"keep").unwrap();
    let error = clear_stale(&path).unwrap_err();
    assert!(matches!(error, ListenerError::NotSocket));
    assert_eq!(error.message(), "Refusing to replace a non-socket");
    assert_eq!(fs::read(&path).unwrap(), b"keep");
}

#[test]
fn live_socket_is_refused_and_kept() {
    let root = scratch("live");
    let path = root.join("broker.sock");
    let _live = UnixListener::bind(&path).unwrap();
    let error = clear_stale(&path).unwrap_err();
    assert!(matches!(error, ListenerError::AlreadyListening));
    assert_eq!(
        error.message(),
        "Another worker broker is already listening"
    );
    assert!(fs::symlink_metadata(&path).unwrap().file_type().is_socket());
}

#[test]
fn refused_socket_is_removed() {
    let root = scratch("stale");
    let path = root.join("broker.sock");
    drop(UnixListener::bind(&path).unwrap());
    assert!(path.exists() || fs::symlink_metadata(&path).is_ok());
    clear_stale(&path).unwrap();
    assert!(fs::symlink_metadata(&path).is_err());
}

#[test]
fn bound_socket_is_private_and_removed_by_identity() {
    let root = scratch("bind");
    let path = root.join("broker.sock");
    let mut bound = BoundSocket::bind(&path).unwrap();
    let metadata = fs::symlink_metadata(&path).unwrap();
    assert_eq!(metadata.mode() & 0o777, 0o600);
    assert_eq!(bound.identity(), [metadata.dev(), metadata.ino()]);
    let client = UnixStream::connect(&path).unwrap();
    let (server, _) = bound.listener().unwrap().accept().unwrap();
    assert_eq!(peer_uid(&server).unwrap(), me());
    drop((client, server));
    assert!(bound.remove().unwrap());
    assert!(fs::symlink_metadata(&path).is_err());
}

#[test]
fn replaced_leaf_is_not_removed() {
    let root = scratch("replaced");
    let path = root.join("broker.sock");
    let mut bound = BoundSocket::bind(&path).unwrap();
    fs::remove_file(&path).unwrap();
    let _other = UnixListener::bind(&path).unwrap();
    assert!(!bound.remove().unwrap());
    assert!(fs::symlink_metadata(&path).unwrap().file_type().is_socket());
}

#[test]
fn error_payload_cuts_at_1000_bytes_even_mid_code_point() {
    assert_eq!(
        error_payload("Invalid worker request"),
        b"Invalid worker request"
    );
    let message = format!("{}é", "a".repeat(999));
    let payload = error_payload(&message);
    assert_eq!(payload.len(), 1000);
    assert_eq!(payload[999], 0xC3, "first byte of é kept, second cut");
}

#[test]
fn peek_leaves_the_frame_for_its_owner() {
    let (mut client, mut server) = UnixStream::pair().unwrap();
    write_frame(&mut client, b'T', b"{}").unwrap();
    assert_eq!(peek_kind(&server).unwrap(), b'T');
    assert_eq!(read_frame(&mut server).unwrap(), (b'T', b"{}".to_vec()));
}

#[test]
fn oversized_length_is_refused_before_reading_the_payload() {
    use std::io::Write;
    let (mut client, mut server) = UnixStream::pair().unwrap();
    let length = (reverie_core::worker_wire::MAX_FRAME as u32 + 1).to_be_bytes();
    client
        .write_all(&[b'C', length[0], length[1], length[2], length[3]])
        .unwrap();
    assert!(matches!(read_frame(&mut server), Err(FrameError::TooLarge)));
    let too_big = vec![0u8; reverie_core::worker_wire::MAX_FRAME + 1];
    assert!(matches!(
        write_frame(&mut client, b'J', &too_big),
        Err(FrameError::TooLarge)
    ));
}

#[test]
fn a_peer_that_closes_mid_frame_gets_no_reply() {
    use std::io::Write;
    let (mut client, mut server) = UnixStream::pair().unwrap();
    client.write_all(&[b'C', 0, 0, 0, 9, b'{']).unwrap();
    drop(client);
    assert!(matches!(read_frame(&mut server), Err(FrameError::Closed)));
    assert!(matches!(
        peek_kind(&server),
        Ok(_) | Err(FrameError::Closed)
    ));
    let (client, server) = UnixStream::pair().unwrap();
    drop(client);
    assert!(matches!(peek_kind(&server), Err(FrameError::Closed)));
}
