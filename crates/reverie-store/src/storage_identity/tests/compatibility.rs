use super::*;
use std::ffi::OsString;
use std::os::unix::ffi::OsStringExt;

#[test]
fn inaccessible_tail_is_path_data_but_never_metadata_custody() {
    let tree = Tree::new();
    let hidden = tree.root.join("inaccessible");
    fs::create_dir(&hidden).unwrap();
    tree.write(&hidden.join("company.json"), "{\"employees\":[]}");
    fs::set_permissions(&hidden, fs::Permissions::from_mode(0o000)).unwrap();
    let path = hidden.join("future");
    let normalized = canonical(&path);
    let read = read_metadata(&hidden.join("company.json"), uid(), DEFAULT_METADATA_LIMIT);
    let config = StorageIdentityConfig::try_new(
        tree.company_file(),
        hidden.join("state"),
        hidden.join("scratch"),
        uid(),
    )
    .unwrap();
    let result = storage_paths(&config, &session(A));
    fs::set_permissions(&hidden, fs::Permissions::from_mode(0o700)).unwrap();
    assert_eq!(normalized.unwrap(), path);
    // The legacy exists()/is_symlink() calls can themselves refuse inaccessible
    // index paths; canonical() alone is deliberately not an access guarantee.
    // A root test process can actually traverse its own000 directory. The
    // ordinary unprivileged native gate exercises the EACCES refusal path.
    assert_eq!(read.is_err(), uid() != 0);
    assert_eq!(result.is_err(), uid() != 0);
}

#[test]
fn native_non_utf8_paths_are_not_lossily_converted_to_request_strings() {
    let tree = Tree::new();
    let path = tree
        .root
        .join(OsString::from_vec(b"metadata-\xff.json".to_vec()));
    tree.write(&path, "{\"employees\":[]}");
    assert_eq!(
        read_metadata(&path, uid(), DEFAULT_METADATA_LIMIT)
            .unwrap()
            .company_records()
            .unwrap()
            .records()
            .len(),
        0
    );
}

#[test]
fn metadata_growth_and_premature_eof_between_stat_and_read_refuse() {
    for growing in [false, true] {
        let tree = Tree::new();
        let size = fs::metadata(tree.company_file()).unwrap().len() as usize;
        let replacement = if growing {
            "x".repeat(size + 1)
        } else {
            String::new()
        };
        inject(move |point, path| {
            if matches!(point, Point::BeforeRead) {
                fs::write(path, &replacement).unwrap();
            }
            Ok(())
        });
        let error = read_metadata(&tree.company_file(), uid(), size)
            .err()
            .unwrap();
        assert_eq!(
            error.code(),
            if growing {
                "STORAGE_METADATA_BOUND"
            } else {
                "STORAGE_METADATA_CHANGED"
            }
        );
        assert_eq!(tree.fd_count(), 0);
    }
}

#[test]
fn ancestor_becoming_a_symlink_during_read_refuses_the_named_alias() {
    let tree = Tree::new();
    let directory = tree.root.join("metadata");
    fs::create_dir(&directory).unwrap();
    let path = directory.join("company.json");
    tree.write(&path, "{\"employees\":[]}");
    let moved = tree.root.join("original");
    inject(move |point, _| {
        if matches!(point, Point::AfterRead) {
            fs::rename(&directory, &moved).unwrap();
            symlink(&moved, &directory).unwrap();
        }
        Ok(())
    });
    assert!(read_metadata(&path, uid(), DEFAULT_METADATA_LIMIT).is_err());
    assert_eq!(tree.fd_count(), 0);
}

#[test]
fn plan_move_shape_bound_and_lineage_exact_schema_are_enforced_only_when_used() {
    let tree = Tree::new();
    let config = tree.config();
    tree.company(&[row(E, B, "2", "true", "false")], &[]);
    for raw in ["{}", "[null]", &format!("[{}]", vec!["{}"; 101].join(","))] {
        tree.write(&tree.root.join("plan-moves.json"), raw);
        assert!(storage_paths(&config, &session(A)).is_err());
        assert!(storage_paths(&config, &session(B)).is_ok());
    }
    fs::remove_file(tree.root.join("plan-moves.json")).unwrap();
    let marker = tree.state().join(A).join("storage-owner.json");
    for raw in [
        "{}",
        &format!(
            "{{\"version\":1,\"employeeId\":\"{E}\",\"sessionId\":\"{A}\",\"owner\":\"owner-a\",\"extra\":null}}"
        ),
        &format!(
            "{{\"version\":0,\"employeeId\":\"{E}\",\"sessionId\":\"{A}\",\"owner\":\"owner-a\"}}"
        ),
    ] {
        tree.write(&marker, raw);
        assert!(storage_paths(&config, &session(A)).is_err());
    }
}

#[test]
fn null_and_lone_surrogate_owners_survive_native_registry_and_lineage_matching() {
    let tree = Tree::new();
    let config = tree.config();
    for owner in ["null", r#""\ud800""#] {
        tree.write(&tree.company_file(),&format!("{{\"employees\":[{{\"id\":\"{E}\",\"sessionId\":\"{B}\",\"sessionGeneration\":1,\"owner\":{owner}}}]}}"));
        tree.marker(A, E, owner);
        let historical = storage_paths(&config, &session(A)).unwrap();
        assert_eq!(historical.identity(), E);
        assert!(!storage_start_allowed(&config, &historical).unwrap());
        assert_eq!(
            current_employee(&config, &session(B))
                .unwrap()
                .unwrap()
                .owner(),
            historical.owner()
        );
    }
}
#[test]
fn native_metadata_reader_enforces_scoped_parse_hooks_and_checks_close_failure() {
    let tree = Tree::new();
    let raw = format!("{{\"opaque\":{}}}", "7".repeat(4301));
    tree.write(&tree.company_file(), &raw);
    assert_eq!(
        read_metadata(&tree.company_file(), uid(), DEFAULT_METADATA_LIMIT)
            .err()
            .unwrap()
            .code(),
        "METADATA_JSON"
    );
    assert_eq!(tree.fd_count(), 0);
    tree.write(&tree.company_file(), r#"{"x":0,"x":1,"tail":[}"#);
    faults::STATE.with(|state| state.borrow_mut().close = Some(private_fs::CloseRole::Data));
    let error = read_metadata(&tree.company_file(), uid(), DEFAULT_METADATA_LIMIT)
        .err()
        .unwrap();
    match error {
        IdentityError::Finalization { primary, secondary } => {
            assert_eq!(primary.code(), "METADATA_JSON");
            assert_eq!(secondary.code(), "STORE_IO");
        }
        other => panic!("expected parse and close failures, got{other:?}"),
    }
    assert_eq!(tree.fd_count(), 0);
}
