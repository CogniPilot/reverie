use super::*;
fn material(path: &Path) -> io::Result<Vec<u8>> {
    material_with_close(path, |file| {
        nix::unistd::close(file).map_err(io::Error::from)
    })
}
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};
fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
}
fn pools() -> (BytePool, BytePool) {
    (
        BytePool::new(crate::DIRECTION_BYTES).unwrap(),
        BytePool::new(crate::DIRECTION_BYTES).unwrap(),
    )
}
#[test]
fn encrypted_input_quota_survives_partial_reads_and_pending_without_extra_allocation() {
    runtime().block_on(async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut peer = TcpStream::connect(listener.local_addr().unwrap())
            .await
            .unwrap();
        let (socket, _) = listener.accept().await.unwrap();
        let (incoming, outgoing) = pools();
        let budget = TlsBudget::reserve(&incoming, &outgoing).unwrap();
        let mut wire = Wire {
            socket,
            input: 0,
            maximum: 8,
            _budget: budget,
        };
        for expected in 1..=8 {
            peer.write_all(&[1]).await.unwrap();
            assert_eq!(wire.read(&mut [0; 64]).await.unwrap(), 1);
            assert_eq!(wire.input, expected);
        }
        assert_eq!(wire.read(&mut []).await.unwrap(), 0);
        assert_eq!(
            wire.read(&mut [0; 64]).await.unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
        drop(wire);
        assert_eq!(incoming.issued(), 0);
        assert_eq!(outgoing.issued(), 0);
    });
}
#[test]
fn established_budget_keeps_record_overhead_charged_after_handshake_scratch_returns() {
    let (incoming, outgoing) = pools();
    let mut budget = TlsBudget::reserve(&incoming, &outgoing).unwrap();
    assert_eq!(incoming.issued(), HANDSHAKE_RESERVE as usize);
    budget.established();
    assert_eq!(incoming.issued(), TLS_RESERVE as usize);
    assert_eq!(outgoing.issued(), TLS_RESERVE as usize);
    drop(budget);
    assert_eq!(incoming.issued(), 0);
    assert_eq!(outgoing.issued(), 0);
}
#[test]
fn nonregular_material_and_relative_bootstrap_paths_are_refused() {
    assert_eq!(
        material(Path::new("/dev/null")).unwrap_err().kind(),
        io::ErrorKind::InvalidData
    );
    assert!(TlsFiles::new("relative.crt".into(), "/absolute.key".into()).is_err());
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/tls/fixtures/localhost.crt");
    assert!(!material(&path).unwrap().is_empty());
}
#[test]
fn material_bound_and_symlink_capture_are_checked_before_pem_parsing() {
    use std::os::unix::fs::{DirBuilderExt, symlink};
    let directory =
        std::env::temp_dir().join(format!("reverie-tls-material-{}", std::process::id()));
    std::fs::DirBuilder::new()
        .mode(0o700)
        .create(&directory)
        .unwrap();
    let target = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/tls/fixtures/localhost.crt");
    let alias = directory.join("alias");
    symlink(&target, &alias).unwrap();
    assert_eq!(material(&alias).unwrap(), material(&target).unwrap());
    let oversized = directory.join("oversized");
    std::fs::write(&oversized, vec![b'x'; MATERIAL_BYTES as usize + 1]).unwrap();
    assert_eq!(
        material(&oversized).unwrap_err().kind(),
        io::ErrorKind::InvalidData
    );
    std::fs::remove_file(alias).unwrap();
    std::fs::remove_file(oversized).unwrap();
    std::fs::remove_dir(directory).unwrap();
}
#[test]
fn oversized_fragmented_handshake_message_is_refused_and_returns_transport_charges() {
    runtime().block_on(async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut peer = TcpStream::connect(listener.local_addr().unwrap())
            .await
            .unwrap();
        let (server, _) = listener.accept().await.unwrap();
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/tls/fixtures");
        let config = TlsFiles::new(root.join("localhost.crt"), root.join("localhost.key"))
            .unwrap()
            .load()
            .await
            .unwrap();
        let (incoming, outgoing) = pools();
        let budget = TlsBudget::reserve(&incoming, &outgoing).unwrap();
        let scratch = SharedScratch::reserve(&incoming).unwrap();
        let task = tokio::spawn(handshake(server, config, budget, scratch));
        // TLS handshake record with a declared 65536-byte ClientHello. Sending
        // the header in separate writes exercises retained fragment state.
        peer.write_all(&[22, 3, 3, 0, 4]).await.unwrap();
        tokio::task::yield_now().await;
        peer.write_all(&[1, 1, 0, 0]).await.unwrap();
        let result = tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .unwrap()
            .unwrap();
        assert!(result.is_err());
        assert_eq!(incoming.issued(), 0);
        assert_eq!(outgoing.issued(), 0);
    });
}
#[test]
fn checked_material_close_retains_primary_failure_and_never_returns_material_on_close_fault() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/tls/fixtures");
    let files = TlsFiles::new(root.join("localhost.crt"), root.join("localhost.key"))
        .unwrap()
        .with_material_close_failure();
    let error = files.material(&root.join("localhost.crt")).unwrap_err();
    assert!(
        error
            .to_string()
            .contains("injected TLS material close failure")
    );
    // The same finalizer runs after failed metadata/type validation and really
    // consumes/closes the File before injecting acknowledgement loss.
    let error = files.material(Path::new("/dev/null")).unwrap_err();
    let text = error.to_string();
    assert!(text.contains("bounded regular file"));
    assert!(text.contains("injected TLS material close failure"));
}
