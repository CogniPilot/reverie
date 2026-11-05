use super::*;

#[test]
fn canonical_paths_reject_aliases_and_allow_nonexistent_or_nondirectory_tails() {
    let tree = Tree::new();
    let missing = tree.root.join("missing/future/tail");
    assert_eq!(canonical(&missing).unwrap(), missing);
    assert!(!missing.exists());
    let file = tree.root.join("plain");
    tree.write(&file, "{}");
    assert_eq!(
        canonical(&file.join("future")).unwrap(),
        file.join("future")
    );
    let alias = tree.root.join("alias");
    symlink(&tree.root, &alias).unwrap();
    assert!(canonical(&alias.join("future")).is_err());
    for path in [
        PathBuf::from("relative"),
        tree.root.join("../tail"),
        tree.root.join("./tail"),
        PathBuf::from(format!("{}//tail", tree.root.display())),
        PathBuf::from(format!("{}/", tree.root.display())),
    ] {
        assert!(canonical(&path).is_err(), "{path:?}");
    }
    tree.write(&tree.state(), "{}");
    assert!(storage_paths(&tree.config(), &session(A)).is_ok());
}

#[test]
fn metadata_uses_legacy_read_permissions_and_refuses_wrong_uid_links_types_and_size() {
    let tree = Tree::new();
    let path = tree.company_file();
    for mode in [0o400, 0o600, 0o640, 0o644, 0o700] {
        fs::set_permissions(&path, fs::Permissions::from_mode(mode)).unwrap();
        assert!(read_metadata(&path, uid(), DEFAULT_METADATA_LIMIT).is_ok());
    }
    for mode in [0o620, 0o602, 0o666] {
        fs::set_permissions(&path, fs::Permissions::from_mode(mode)).unwrap();
        assert_eq!(
            read_metadata(&path, uid(), DEFAULT_METADATA_LIMIT)
                .err()
                .unwrap()
                .code(),
            "TRUSTED_STORAGE_METADATA"
        );
    }
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    assert!(read_metadata(&path, uid() + 1, DEFAULT_METADATA_LIMIT).is_err());
    assert!(read_metadata(&path, uid(), 1).is_err());
    let link = tree.root.join("hardlink");
    fs::hard_link(&path, &link).unwrap();
    assert!(read_metadata(&path, uid(), DEFAULT_METADATA_LIMIT).is_err());
    fs::remove_file(&link).unwrap();
    symlink(&path, &link).unwrap();
    assert!(read_metadata(&link, uid(), DEFAULT_METADATA_LIMIT).is_err());
    fs::remove_file(&link).unwrap();
    private_fs::fifo(&link);
    assert!(read_metadata(&link, uid(), DEFAULT_METADATA_LIMIT).is_err());
    assert!(read_metadata(&tree.root, uid(), DEFAULT_METADATA_LIMIT).is_err());
}

#[test]
fn duplicate_nested_metadata_and_missing_files_are_refusals_without_initialization() {
    let tree = Tree::new();
    tree.write(
        &tree.company_file(),
        "{\"employees\":[],\"x\":{\"a\":1,\"a\":2}}",
    );
    assert_eq!(
        read_metadata(&tree.company_file(), uid(), DEFAULT_METADATA_LIMIT)
            .err()
            .unwrap()
            .code(),
        "DUPLICATE_KEY"
    );
    fs::remove_file(tree.company_file()).unwrap();
    assert!(storage_paths(&tree.config(), &session(A)).is_err());
    assert!(!tree.company_file().exists());
    assert!(!tree.state().exists());
}

#[test]
fn named_replacement_same_inode_changes_and_hardlinks_during_read_refuse() {
    for mutation in [0, 1, 2, 3] {
        let tree = Tree::new();
        let path = tree.company_file();
        let root = tree.root.clone();
        inject(move |point, current| {
            if matches!(point, Point::AfterRead) {
                mutate_file(mutation, current, &root);
            }
            Ok(())
        });
        assert_eq!(
            read_metadata(&path, uid(), DEFAULT_METADATA_LIMIT)
                .err()
                .unwrap()
                .code(),
            "STORAGE_METADATA_CHANGED"
        );
        assert_eq!(tree.fd_count(), 0);
    }
}
fn mutate_file(mutation: usize, current: &Path, root: &Path) {
    match mutation {
        0 => {
            fs::rename(current, root.join("old")).unwrap();
            fs::copy(root.join("old"), current).unwrap();
        }
        1 => fs::write(current, b"{\"employees\":[]}").unwrap(),
        2 => fs::set_permissions(current, fs::Permissions::from_mode(0o644)).unwrap(),
        _ => fs::hard_link(current, root.join("linked")).unwrap(),
    }
}

#[test]
fn checked_walk_and_data_closes_refuse_and_retain_primary_parse_failure() {
    let tree = Tree::new();
    for role in [private_fs::CloseRole::Walk, private_fs::CloseRole::Data] {
        faults::STATE.with(|value| value.borrow_mut().close = Some(role));
        assert!(read_metadata(&tree.company_file(), uid(), DEFAULT_METADATA_LIMIT).is_err());
        assert_eq!(tree.fd_count(), 0);
    }
    tree.write(&tree.company_file(), "not json");
    faults::STATE.with(|value| value.borrow_mut().close = Some(private_fs::CloseRole::Data));
    assert!(matches!(
        read_metadata(&tree.company_file(), uid(), DEFAULT_METADATA_LIMIT),
        Err(IdentityError::Finalization { .. })
    ));
    assert_eq!(tree.fd_count(), 0);
}
