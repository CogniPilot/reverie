use super::*;
use crate::private_fs::CloseRole;
use std::os::unix::fs::symlink;

fn alter_temporary(path: &Path, alteration: &str) {
    let source = fs::read_dir(path)
        .unwrap()
        .flatten()
        .find(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with(".profiles-")
        })
        .unwrap()
        .path();
    match alteration {
        "replace" => {
            fs::remove_file(&source).unwrap();
            fs::write(&source, b"foreign replacement").unwrap();
        }
        "edit" => fs::write(&source, b"edited own temporary").unwrap(),
        "link" => fs::hard_link(&source, path.join("foreign-alias")).unwrap(),
        _ => fs::set_permissions(&source, fs::Permissions::from_mode(0o644)).unwrap(),
    }
}
fn rewrite(path: &Path, bytes: &[u8], replace: bool) {
    if replace {
        fs::remove_file(path).unwrap();
    }
    fs::write(path, bytes).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
}

#[test]
fn failed_file_sync_is_before_publication_and_cleans_only_its_owned_temporary() {
    let tree = Tree::new();
    let store = tree.save();
    let before = tree.raw();
    inject(|point, _| {
        if point == Point::FileSync {
            Err(injected())
        } else {
            Ok(())
        }
    });
    assert_pre_refusal(store.put(&next_intent()));
    faults::reset();
    assert_eq!(tree.raw(), before);
    assert!(tree.temporaries().is_empty());
    assert_eq!(tree.fd_count(), 1);
}
#[test]
fn early_preparation_errors_close_fds_and_retain_only_unproven_namespace() {
    for point in [Point::InitialTemporaryMetadata, Point::BeforeTemporaryPin] {
        let tree = Tree::new();
        let store = tree.save();
        let before = tree.raw();
        inject(move |actual, _| {
            if actual == point {
                Err(injected())
            } else {
                Ok(())
            }
        });
        let error = assert_pre_refusal(store.put(&next_intent()));
        faults::reset();
        assert_eq!(tree.raw(), before);
        assert_eq!(
            tree.temporaries().len(),
            usize::from(point == Point::InitialTemporaryMetadata)
        );
        assert_eq!(tree.fd_count(), 1);
        if point == Point::InitialTemporaryMetadata {
            assert_eq!(error.code(), "STORE_PREPARATION_FAILED_RETAIN_RAW");
        }
    }
}
#[test]
fn created_file_permission_failure_retains_raw_and_checked_close_evidence() {
    let tree = Tree::new();
    let store = tree.save();
    let before = tree.raw();
    inject(|point, _| {
        if point == Point::CreatedFilePermissions {
            Err(injected())
        } else {
            Ok(())
        }
    });
    faults::STATE.with(|state| state.borrow_mut().close = Some(CloseRole::Temporary));
    let error = assert_pre_refusal(store.put(&next_intent()));
    assert!(matches!(error, StoreError::Finalization { .. }));
    faults::reset();
    assert_eq!(tree.raw(), before);
    assert_eq!(tree.temporaries().len(), 1);
    assert_eq!(tree.fd_count(), 1);
}
#[test]
fn a_bad_lock_and_failing_lock_close_preserve_both_errors() {
    let tree = Tree::new();
    let store = tree.save();
    let before = tree.raw();
    let lock = tree.root.join("profiles.lock");
    fs::set_permissions(&lock, fs::Permissions::from_mode(0o644)).unwrap();
    faults::STATE.with(|state| state.borrow_mut().close = Some(CloseRole::Lock));
    let error = assert_pre_refusal(store.put(&next_intent()));
    assert!(matches!(error, StoreError::Finalization { .. }));
    faults::reset();
    assert_eq!(tree.raw(), before);
    assert_eq!(tree.fd_count(), 1);
}
#[test]
fn a_failed_parent_close_releases_the_new_child_descriptor() {
    let tree = Tree::new();
    faults::STATE.with(|state| state.borrow_mut().close = Some(CloseRole::Walk));
    assert!(ProfileStore::open(&tree.root).is_err());
    faults::reset();
    assert_eq!(tree.fd_count(), 0);
}
#[test]
fn short_reads_complete_but_premature_eof_is_not_an_empty_document() {
    let tree = Tree::new();
    let store = tree.save();
    let before = tree.raw();
    faults::STATE.with(|state| state.borrow_mut().read_limit = Some(7));
    assert_eq!(store.snapshot().unwrap().revision().get(), 1);
    faults::STATE.with(|state| state.borrow_mut().read_limit = Some(0));
    assert!(store.snapshot().is_err());
    faults::reset();
    assert_eq!(tree.raw(), before);
    assert_eq!(tree.fd_count(), 1);
}
#[test]
fn a_rename_error_is_conservative_even_when_the_previous_bytes_remain() {
    let tree = Tree::new();
    let store = tree.save();
    let before = tree.raw();
    inject(|point, _| {
        if point == Point::BeforeRename {
            Err(injected())
        } else {
            Ok(())
        }
    });
    assert!(store.put(&next_intent()).unwrap_err().is_uncertain());
    faults::reset();
    assert_eq!(tree.raw(), before);
    assert!(tree.temporaries().is_empty());
}
#[test]
fn lost_rename_acknowledgement_retains_the_committed_profile_and_stale_retry_refuses() {
    let tree = Tree::new();
    let store = tree.save();
    inject(|point, _| {
        if point == Point::AfterRename {
            Err(injected())
        } else {
            Ok(())
        }
    });
    let error = store.put(&next_intent()).unwrap_err();
    assert!(error.is_uncertain());
    assert_eq!(error.code(), "COMMIT_OUTCOME_UNCERTAIN_RETAIN_EVIDENCE");
    faults::reset();
    assert_eq!(store.read_existing().unwrap().revision().get(), 2);
    assert_pre_refusal(store.put(&next_intent()));
    assert!(tree.temporaries().is_empty());
}
#[test]
fn directory_sync_failure_is_uncertain_and_never_rolls_back_published_data() {
    let tree = Tree::new();
    let store = tree.save();
    inject(|point, _| {
        if point == Point::DirectorySync {
            Err(injected())
        } else {
            Ok(())
        }
    });
    assert!(store.put(&next_intent()).unwrap_err().is_uncertain());
    faults::reset();
    assert_eq!(store.snapshot().unwrap().revision().get(), 2);
    assert!(tree.temporaries().is_empty());
}
#[test]
fn rebound_directory_after_rename_never_acknowledges_success() {
    let tree = Tree::new();
    let store = tree.save();
    let original = tree.root.clone();
    let moved = tree.root.with_extension("rebound");
    let saved = moved.clone();
    inject(move |point, _| {
        if point == Point::AfterRename {
            fs::rename(&original, &moved).unwrap();
            fs::create_dir(&original).unwrap();
            fs::set_permissions(&original, fs::Permissions::from_mode(0o700)).unwrap();
        }
        Ok(())
    });
    let result = store.put(&next_intent());
    faults::reset();
    fs::remove_dir(&tree.root).unwrap();
    fs::rename(saved, &tree.root).unwrap();
    assert!(result.unwrap_err().is_uncertain());
    assert_eq!(store.snapshot().unwrap().revision().get(), 2);
}
#[test]
fn source_substitution_edit_link_and_mode_changes_refuse_before_publication() {
    for alteration in ["replace", "edit", "link", "mode"] {
        let tree = Tree::new();
        let store = tree.save();
        let before = tree.raw();
        inject(move |point, path| {
            if point == Point::AfterTemporaryPrepared {
                alter_temporary(path, alteration);
            }
            Ok(())
        });
        assert_pre_refusal(store.put(&next_intent()));
        faults::reset();
        assert_eq!(tree.raw(), before);
        assert_eq!(
            tree.temporaries().len(),
            usize::from(alteration == "replace")
        );
        assert_eq!(tree.fd_count(), 1);
    }
}
#[test]
fn a_changed_named_document_during_read_is_refused_without_repair() {
    for replace in [false, true] {
        let tree = Tree::new();
        let store = tree.save();
        let raw = tree.raw();
        inject(move |point, path| {
            if point == Point::AfterDataRead {
                let target = path.join("profiles.json");
                rewrite(&target, &raw, replace);
            }
            Ok(())
        });
        assert!(store.read_existing().is_err());
        faults::reset();
        assert_eq!(store.read_existing().unwrap().revision().get(), 1);
    }
}
#[test]
fn a_stale_data_or_lock_replacement_before_publish_is_not_committed() {
    for lock in [false, true] {
        let leaf = if lock {
            "profiles.lock"
        } else {
            "profiles.json"
        };
        let tree = Tree::new();
        let store = tree.save();
        let before = tree.raw();
        inject(move |point, path| {
            if point == Point::AfterTemporaryPrepared {
                let selected = path.join(leaf);
                let bytes = fs::read(&selected).unwrap();
                fs::remove_file(&selected).unwrap();
                fs::write(&selected, bytes).unwrap();
                fs::set_permissions(&selected, fs::Permissions::from_mode(0o600)).unwrap();
            }
            Ok(())
        });
        assert_pre_refusal(store.put(&next_intent()));
        faults::reset();
        assert_eq!(tree.raw(), before);
        assert!(tree.temporaries().is_empty());
    }
}
#[test]
fn partial_writes_complete_and_zero_or_failed_writes_leave_the_old_document() {
    let tree = Tree::new();
    let store = tree.save();
    faults::STATE.with(|state| state.borrow_mut().write_limit = Some(3));
    assert_eq!(store.put(&next_intent()).unwrap().revision().get(), 2);
    faults::reset();
    assert!(tree.temporaries().is_empty());
    for zero in [false, true] {
        let tree = Tree::new();
        let store = tree.save();
        let before = tree.raw();
        faults::STATE.with(|state| {
            let mut state = state.borrow_mut();
            if zero {
                state.write_limit = Some(0);
            } else {
                state.fail_write = true;
            }
        });
        assert_pre_refusal(store.put(&next_intent()));
        faults::reset();
        assert_eq!(tree.raw(), before);
        assert!(tree.temporaries().is_empty());
        assert_eq!(tree.fd_count(), 1);
    }
}
#[test]
fn failing_lock_anchor_data_and_recheck_closes_after_publication_are_uncertain() {
    for role in [
        CloseRole::Lock,
        CloseRole::TemporaryAnchor,
        CloseRole::Data,
        CloseRole::Recheck,
    ] {
        let tree = Tree::new();
        let store = tree.save();
        inject(move |point, _| {
            if point == Point::AfterRename {
                faults::STATE.with(|state| state.borrow_mut().close = Some(role));
            }
            Ok(())
        });
        let error = store.put(&next_intent()).unwrap_err();
        assert!(error.is_uncertain(), "{role:?}: {error:?}");
        faults::reset();
        assert_eq!(store.snapshot().unwrap().revision().get(), 2);
        assert_eq!(tree.fd_count(), 1);
    }
}
#[test]
fn failing_prepublication_writer_close_never_renames_data() {
    let tree = Tree::new();
    let store = tree.save();
    let before = tree.raw();
    faults::STATE.with(|state| state.borrow_mut().close = Some(CloseRole::Temporary));
    assert_pre_refusal(store.put(&next_intent()));
    faults::reset();
    assert_eq!(tree.raw(), before);
    assert!(tree.temporaries().is_empty());
    assert_eq!(tree.fd_count(), 1);
}
#[test]
fn checked_store_close_never_silently_discards_a_close_error() {
    let tree = Tree::new();
    let store = tree.save();
    faults::STATE.with(|state| state.borrow_mut().close = Some(CloseRole::Store));
    assert!(store.close().unwrap_err().is_uncertain());
    faults::reset();
    assert_eq!(tree.fd_count(), 0);
    assert_eq!(tree.open().snapshot().unwrap().revision().get(), 1);
}
#[test]
fn same_bytes_target_replacement_after_temporary_finalizers_is_uncertain() {
    let tree = Tree::new();
    let store = tree.save();
    inject(|point, path| {
        if point == Point::AfterTemporaryCleanup {
            let target = path.join("profiles.json");
            let bytes = fs::read(&target).unwrap();
            fs::rename(&target, path.join("replaced-profile.json")).unwrap();
            fs::write(&target, bytes).unwrap();
            fs::set_permissions(&target, fs::Permissions::from_mode(0o600)).unwrap();
        }
        Ok(())
    });
    assert!(store.put(&next_intent()).unwrap_err().is_uncertain());
    faults::reset();
    assert_eq!(store.snapshot().unwrap().revision().get(), 2);
}
#[test]
fn ancestor_rebinding_before_publish_refuses_even_if_the_leaf_is_the_same_inode() {
    let tree = Tree::new();
    let parent = tree.root.join("parent");
    let leaf = parent.join("store");
    fs::create_dir(&parent).unwrap();
    fs::create_dir(&leaf).unwrap();
    fs::set_permissions(&leaf, fs::Permissions::from_mode(0o700)).unwrap();
    let store = ProfileStore::open(&leaf).unwrap();
    store.put(&new_intent()).unwrap();
    let moved = tree.root.join("moved");
    let original = parent.clone();
    let saved = moved.clone();
    inject(move |point, _| {
        if point == Point::AfterTemporaryPrepared {
            fs::rename(&original, &moved).unwrap();
            symlink(&moved, &original).unwrap();
        }
        Ok(())
    });
    let result = store.put(&next_intent());
    faults::reset();
    fs::remove_file(&parent).unwrap();
    fs::rename(saved, parent).unwrap();
    assert_pre_refusal(result);
    assert_eq!(store.snapshot().unwrap().revision().get(), 1);
}
