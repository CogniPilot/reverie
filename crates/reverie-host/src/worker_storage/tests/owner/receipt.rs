use super::*;

#[test]
fn actual_legacy_receipt_keeps_empty_nul_parent_and_dangling_path_dispositions() {
    let tree = Tree::new();
    let runtime = runtime(&tree);
    let mut owner = runtime
        .resolve_storage(&selected(&tree), &session(B))
        .unwrap()
        .into_legacy()
        .unwrap();
    owner.prepare_storage().unwrap();
    owner.prepare_runtime_directory().unwrap();
    let launch = owner.paths().home().join(".reverie-launch");
    tree.mkdir(&launch);
    tree.write(&owner.paths().home().join("done"), b"0");
    symlink(tree.0.join("absent"), launch.join("dangling")).unwrap();
    for (exit, expected) in [
        ("", true),
        ("x\0y", false),
        ("../done", true),
        ("dangling", false),
    ] {
        tree.write(
            &tree.state().join(B).join("runtime.json"),
            &serde_json::to_vec(&json!({"exit":exit})).unwrap(),
        );
        assert_eq!(
            owner.observe_launch_receipt().unwrap().exists(),
            expected,
            "{exit:?}"
        );
    }
    assert!(
        !tree.state().join("storage-locks").exists(),
        "legacy read never mints a lease"
    );
    owner.close(end()).unwrap();
    runtime.close(end()).unwrap();
}

#[test]
fn runtime_read_close_failure_refuses_positive_data_and_preserves_both_actual_failures() {
    let tree = Tree::new();
    let runtime = runtime(&tree);
    let mut owner = runtime
        .resolve_storage(&selected(&tree), &session(B))
        .unwrap()
        .into_legacy()
        .unwrap();
    owner.prepare_storage().unwrap();
    owner.prepare_runtime_directory().unwrap();
    let leaf = tree.state().join(B).join("runtime.json");
    tree.write(&leaf, br#"{"exit":""}"#);
    native::test_faults::set(None, true);
    let one = owner.observe_launch_receipt().err().unwrap();
    native::test_faults::set(None, false);
    assert!(matches!(one, StorageOwnerError::Storage(_)));
    stdfs::remove_file(&leaf).unwrap();
    tree.mkdir(&leaf); // open succeeds; the actual read refuses EISDIR.
    native::test_faults::set(None, true);
    let both = owner.observe_launch_receipt().err().unwrap();
    native::test_faults::set(None, false);
    let StorageOwnerError::Finalized { primary, secondary } = both else {
        panic!("actual read+checked-close failures")
    };
    assert!(matches!(*primary, StorageOwnerError::Path(_)));
    assert_eq!(secondary.len(), 1);
    assert!(matches!(secondary[0], StorageOwnerError::Storage(_)));
    assert_eq!(owner.ownership_kind(), StorageOwnershipKind::UnleasedLegacy);
    owner.close(end()).unwrap();
    runtime.close(end()).unwrap();
}

#[test]
fn runtime_fifo_with_finite_owned_writer_preserves_original_read_text_acceptance() {
    use std::{io::Write, sync::mpsc, time::Instant};
    let tree = Tree::new();
    let runtime = runtime(&tree);
    let mut owner = runtime
        .resolve_storage(&selected(&tree), &session(B))
        .unwrap()
        .into_legacy()
        .unwrap();
    owner.prepare_storage().unwrap();
    owner.prepare_runtime_directory().unwrap();
    tree.mkdir(&owner.paths().home().join(".reverie-launch"));
    let leaf = tree.state().join(B).join("runtime.json");
    nix::unistd::mkfifo(
        &leaf,
        nix::sys::stat::Mode::S_IRUSR | nix::sys::stat::Mode::S_IWUSR,
    )
    .unwrap();
    let source = leaf.clone();
    let began = Instant::now();
    let (release, released) = mpsc::sync_channel(1);
    let writer = std::thread::spawn(move || {
        // Real blocking FIFO open. The finite writer waits for the controller
        // or its five-second fallback, then publishes the unchanged bytes.
        let mut file = stdfs::OpenOptions::new().write(true).open(source).unwrap();
        let opened = began.elapsed();
        let fallback = released.recv_timeout(Duration::from_secs(5)).is_err();
        let written_at = began.elapsed();
        let written = file.write_all(br#"{"exit":""}"#);
        let closed = native::close(file);
        (opened, fallback, written_at, written, closed)
    });
    let result = owner.observe_launch_receipt();
    let finished = began.elapsed();
    // An old nonblocking reader may finish before its writer connects. Wake
    // only this fixture's FIFO so teardown can always join the real writer.
    let teardown = result.is_err().then(|| {
        use std::os::unix::fs::OpenOptionsExt;
        stdfs::OpenOptions::new()
            .read(true)
            .write(true)
            .custom_flags(libc::O_CLOEXEC | libc::O_NONBLOCK)
            .open(&leaf)
            .unwrap()
    });
    let _ = release.send(());
    let (opened, fallback, written_at, written, closed) = writer.join().unwrap();
    let teardown_closed = teardown.map(native::close);
    let owner_closed = owner.close(end());
    let runtime_closed = runtime.close(end());
    eprintln!(
        "finite FIFO actual read={:?}; reader_finished={finished:?}; writer_opened={opened:?}; fallback={fallback}; write_started={written_at:?}; writer_write_ok={}",
        result
            .as_ref()
            .map(|value| value.exists())
            .map_err(StorageOwnerError::code),
        written.is_ok()
    );
    written.unwrap();
    closed.unwrap();
    if let Some(closed) = teardown_closed {
        closed.unwrap();
    }
    owner_closed.unwrap();
    runtime_closed.unwrap();
    assert!(result.unwrap().exists());
}
