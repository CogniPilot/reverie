use super::*;
#[test]
fn actual_python_temporary_recipes_match_held_nil_session_lease() {
    let cases: Value =
        serde_json::from_str(include_str!("../fixtures/temporary-python.json")).unwrap();
    for case in cases["cases"].as_array().unwrap() {
        if case["requiresUnprivileged"] == true && native::uid() == 0 {
            continue;
        }
        let tree = Tree::new();
        let mut lease = StorageLease::acquire_launch(&tree.config(), &session(B)).unwrap();
        let root = tree.0.join("scratch");
        tree.mkdir(&root);
        let scratch = lease.paths().scratch().to_owned();
        let other = tree.0.join("other");
        tree.mkdir(&other);
        tree.write(&other.join("owner-data"), b"unique owner result");
        match case["recipe"].as_str().unwrap() {
            "fresh" => {}
            "existing-owner-data" => {
                tree.mkdir(&scratch.join("tmp"));
                tree.write(&scratch.join("tmp/owner-data"), b"unique owner result")
            }
            "root-mode755" => {
                stdfs::set_permissions(&root, stdfs::Permissions::from_mode(0o755)).unwrap()
            }
            "scratch-symlink" => symlink(&other, &scratch).unwrap(),
            "tmp-symlink" => {
                tree.mkdir(&scratch);
                symlink(&other, scratch.join("tmp")).unwrap()
            }
            "tmp-file" => {
                tree.mkdir(&scratch);
                tree.write(&scratch.join("tmp"), b"occupied owner file")
            }
            "root-mode500" => {
                stdfs::set_permissions(&root, stdfs::Permissions::from_mode(0o500)).unwrap()
            }
            "root-mode100" => {
                stdfs::set_permissions(&root, stdfs::Permissions::from_mode(0o100)).unwrap()
            }
            other => panic!("unknown owned recipe {other}"),
        }
        let result = lease.prepare_temporary();
        stdfs::set_permissions(&root, stdfs::Permissions::from_mode(0o700)).unwrap();
        assert_eq!(
            result.is_ok(),
            case["accepted"].as_bool().unwrap(),
            "{}",
            case["recipe"]
        );
        if let Ok(path) = result {
            assert_eq!(
                u64::from(stdfs::metadata(path).unwrap().mode() & 0o777),
                case["tmpMode"].as_u64().unwrap()
            );
        }
        assert_eq!(
            stdfs::read(other.join("owner-data")).unwrap(),
            b"unique owner result"
        );
        lease.close().unwrap();
    }
}
#[test]
fn actual_lease_prepares_only_fixed_employee_and_nil_session_temporary_directories() {
    let tree = Tree::new();
    for sid in [A, B] {
        let mut lease = StorageLease::acquire_launch(&tree.config(), &session(sid)).unwrap();
        let target = lease.prepare_temporary().unwrap();
        assert_eq!(target, lease.paths().scratch().join("tmp"));
        assert_eq!(stdfs::metadata(&target).unwrap().mode() & 0o777, 0o700);
        tree.write(&target.join("owner-result"), b"preserved");
        assert_eq!(lease.prepare_temporary().unwrap(), target);
        assert_eq!(
            stdfs::read(target.join("owner-result")).unwrap(),
            b"preserved"
        );
        lease.close().unwrap();
    }
}
#[test]
fn temporary_symlink_and_exposed_private_modes_are_refused_without_replacing_owner_data() {
    let tree = Tree::new();
    let mut lease = acquire(&tree);
    let target = lease.prepare_temporary().unwrap();
    stdfs::remove_dir(&target).unwrap();
    let other = tree.0.join("unrelated");
    tree.mkdir(&other);
    symlink(&other, &target).unwrap();
    assert!(lease.prepare_temporary().is_err());
    assert!(
        stdfs::symlink_metadata(&target)
            .unwrap()
            .file_type()
            .is_symlink()
    );
    stdfs::remove_file(&target).unwrap();
    let scratch = lease.paths().scratch().to_owned();
    stdfs::set_permissions(&scratch, stdfs::Permissions::from_mode(0o755)).unwrap();
    assert!(lease.prepare_temporary().is_err());
    assert!(!target.exists());
    stdfs::set_permissions(&scratch, stdfs::Permissions::from_mode(0o700)).unwrap();
    lease.close().unwrap();
}
#[test]
fn workspace_alias_preserves_occupied_paths_and_uses_only_actual_shared_declaration() {
    let tree = Tree::new();
    let mut raw = tree.raw();
    raw["mounts"] = json!([{"source":tree.0.join("shared"),"destination":"/reverie_workspace"}]);
    tree.mkdir(&tree.0.join("shared"));
    let mut lease = StorageLease::acquire_launch(&config(raw), &session(B)).unwrap();
    lease.prepare_storage().unwrap();
    let workspace = lease.paths().home().join("workspace");
    tree.write(&workspace, b"owner content");
    lease.home_workspace_alias().unwrap();
    assert_eq!(stdfs::read(&workspace).unwrap(), b"owner content");
    stdfs::remove_file(&workspace).unwrap();
    symlink("custom-owner-target", &workspace).unwrap();
    lease.home_workspace_alias().unwrap();
    assert_eq!(
        stdfs::read_link(&workspace).unwrap(),
        PathBuf::from("custom-owner-target")
    );
    stdfs::remove_file(&workspace).unwrap();
    lease.home_workspace_alias().unwrap();
    assert_eq!(
        stdfs::read_link(&workspace).unwrap(),
        PathBuf::from("/reverie_workspace")
    );
    lease.close().unwrap();
}
#[test]
fn managed_instruction_update_preserves_all_owner_text_and_is_idempotent() {
    let tree = Tree::new();
    let mut lease = acquire(&tree);
    lease.prepare_storage().unwrap();
    let path = lease.paths().home().join("AGENTS.md");
    let owner = "Owner CRLF\r\nα🌍\n".as_bytes();
    tree.write(&path, owner);
    let expected = reverie_contracts::worker_storage::storage_instruction_bytes(owner).unwrap();
    lease.write_storage_instructions().unwrap();
    assert_eq!(stdfs::read(&path).unwrap(), expected);
    lease.write_storage_instructions().unwrap();
    assert_eq!(stdfs::read(&path).unwrap(), expected);
    assert_eq!(stdfs::metadata(path).unwrap().mode() & 0o777, 0o600);
    lease.close().unwrap();
}
#[test]
fn instruction_hardlinks_symlinks_bad_utf8_and_ambiguous_markers_are_preserved_and_refused() {
    let tree = Tree::new();
    let mut lease = acquire(&tree);
    lease.prepare_storage().unwrap();
    let path = lease.paths().home().join("AGENTS.md");
    let other = tree.0.join("outside");
    tree.write(&other, b"unique source");
    symlink(&other, &path).unwrap();
    assert!(lease.write_storage_instructions().is_err());
    assert_eq!(stdfs::read(&other).unwrap(), b"unique source");
    stdfs::remove_file(&path).unwrap();
    stdfs::hard_link(&other, &path).unwrap();
    assert!(lease.write_storage_instructions().is_err());
    stdfs::remove_file(&path).unwrap();
    for bytes in [
        b"\xff".as_slice(),
        b"<!-- reverie-laptop-storage -->".as_slice(),
        &vec![b'x'; 65537],
    ] {
        tree.write(&path, bytes);
        assert!(lease.write_storage_instructions().is_err());
        assert_eq!(stdfs::read(&path).unwrap(), bytes);
    }
    lease.close().unwrap();
}

#[test]
fn instruction_create_collision_preserves_the_preexisting_owner_file() {
    let tree = Tree::new();
    let mut lease = acquire(&tree);
    lease.prepare_storage().unwrap();
    let home = lease.paths().home();
    let name = ".laptop-instructions-owned-collision";
    tree.write(&home.join(name), b"unique owner data");
    assert!(
        super::super::temporary::instruction_collision_for_owned_test(home, name.into()).is_err()
    );
    assert_eq!(stdfs::read(home.join(name)).unwrap(), b"unique owner data");
    assert!(!home.join("AGENTS.md").exists());
    lease.close().unwrap();
}

#[test]
fn instruction_rebind_and_secondary_close_failure_preserve_the_actual_new_owner_file() {
    let tree = Tree::new();
    let mut lease = acquire(&tree);
    lease.prepare_storage().unwrap();
    let path = lease.paths().home().join("AGENTS.md");
    tree.write(&path, b"original");
    PUBLISH.with(|slot| {
        *slot.borrow_mut() = Some(Box::new(|home| {
            stdfs::rename(home.join("AGENTS.md"), home.join("owner-before"))?;
            stdfs::write(home.join("AGENTS.md"), b"new actual owner text")?;
            native::test_faults::set(None, true);
            Ok(())
        }))
    });
    let error = lease.write_storage_instructions().unwrap_err();
    assert!(error.may_have_effects());
    assert!(std::error::Error::source(&error).is_some());
    assert_eq!(stdfs::read(&path).unwrap(), b"new actual owner text");
    assert_eq!(
        stdfs::read(path.with_file_name("owner-before")).unwrap(),
        b"original"
    );
    lease.close().unwrap();
}

#[test]
fn instruction_temporary_replacement_is_neither_published_nor_removed() {
    let tree = Tree::new();
    let mut lease = acquire(&tree);
    lease.prepare_storage().unwrap();
    let path = lease.paths().home().join("AGENTS.md");
    tree.write(&path, b"owner original");
    PUBLISH.with(|slot| {
        *slot.borrow_mut() = Some(Box::new(|home| {
            let temp = stdfs::read_dir(home)?
                .map(|entry| entry.unwrap().path())
                .find(|path| {
                    path.file_name()
                        .unwrap()
                        .to_str()
                        .unwrap()
                        .starts_with(".laptop-instructions-")
                })
                .unwrap();
            stdfs::rename(&temp, home.join("owned-original-temporary"))?;
            stdfs::write(&temp, b"foreign temporary replacement")?;
            Ok(())
        }))
    });
    assert!(
        lease
            .write_storage_instructions()
            .unwrap_err()
            .may_have_effects()
    );
    assert_eq!(stdfs::read(&path).unwrap(), b"owner original");
    let replacement = stdfs::read_dir(path.parent().unwrap())
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .find(|path| {
            path.file_name()
                .unwrap()
                .to_str()
                .unwrap()
                .starts_with(".laptop-instructions-")
        })
        .unwrap();
    assert_eq!(
        stdfs::read(replacement).unwrap(),
        b"foreign temporary replacement"
    );
    lease.close().unwrap();
}

#[test]
fn failed_instruction_publication_retains_own_temporary_without_name_based_cleanup() {
    let tree = Tree::new();
    let mut lease = acquire(&tree);
    lease.prepare_storage().unwrap();
    let agents = lease.paths().home().join("AGENTS.md");
    tree.write(&agents, b"owner original");
    PUBLISH.with(|slot| {
        *slot.borrow_mut() = Some(Box::new(|home| {
            stdfs::rename(home.join("AGENTS.md"), home.join("owner-original"))?;
            stdfs::write(home.join("AGENTS.md"), b"changed actual owner text")?;
            Ok(())
        }))
    });
    assert!(
        lease
            .write_storage_instructions()
            .unwrap_err()
            .may_have_effects()
    );
    let temps = stdfs::read_dir(agents.parent().unwrap())
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| {
            path.file_name()
                .unwrap()
                .to_str()
                .unwrap()
                .starts_with(".laptop-instructions-")
        })
        .collect::<Vec<_>>();
    assert_eq!(
        temps.len(),
        1,
        "failed candidate remains evidence, never unlinked by name"
    );
    assert_eq!(
        stdfs::read(&temps[0]).unwrap(),
        reverie_contracts::worker_storage::storage_instruction_bytes(b"owner original").unwrap()
    );
    assert_eq!(stdfs::read(&agents).unwrap(), b"changed actual owner text");
    lease.close().unwrap();
}
