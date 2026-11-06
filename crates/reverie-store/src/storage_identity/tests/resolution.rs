use super::*;

#[test]
fn current_retired_and_unbound_sessions_keep_separate_stable_storage_namespaces() {
    let tree = Tree::new();
    let config = tree.config();
    let first = storage_paths(&config, &session(A)).unwrap();
    assert_eq!(first.kind(), StorageKind::Employee);
    assert_eq!(first.identity(), E);
    assert_eq!(
        first.home(),
        tree.state().join("employees").join(E).join("home")
    );
    assert_eq!(first.nix(), first.root().join("nix"));
    assert_eq!(first.scratch(), tree.root.join("scratch/employees").join(E));
    assert_eq!(first.key(), format!("employee-{E}"));
    assert!(!tree.state().exists());
    let legacy = storage_paths(&config, &session(C)).unwrap();
    assert_eq!(legacy.kind(), StorageKind::Session);
    assert_eq!(legacy.root(), tree.state().join(C));
    assert_eq!(legacy.key(), format!("session-{C}"));
    assert!(storage_start_allowed(&config, &legacy).unwrap());
    tree.company(&[], &[row(E, A, "1", "true", "false")]);
    assert_eq!(storage_paths(&config, &session(A)).unwrap(), first);
    assert!(!storage_start_allowed(&config, &first).unwrap());
    assert_eq!(current_employee(&config, &session(A)).unwrap(), None);
}

#[test]
fn historical_plan_fallback_preserves_all_phases_and_refuses_foreign_ambiguity() {
    let tree = Tree::new();
    let config = tree.config();
    let first = storage_paths(&config, &session(A)).unwrap();
    tree.company(&[row(E, B, "2", "true", "false")], &[]);
    for phase in [
        "waiting",
        "creating",
        "starting",
        "checking",
        "stopping",
        "completed",
        "failed",
        "recovery-required",
        "quiescing",
    ] {
        tree.journal(E, "\"owner-a\"", phase);
        assert_eq!(storage_paths(&config, &session(A)).unwrap(), first);
        assert!(!storage_start_allowed(&config, &first).unwrap());
        assert!(
            storage_start_allowed(&config, &storage_paths(&config, &session(B)).unwrap()).unwrap()
        );
        assert_eq!(current_employee(&config, &session(A)).unwrap(), None);
    }
    for (employee, owner, phase) in [
        (F, "\"owner-a\"", "starting"),
        (E, "\"owner-b\"", "starting"),
        (E, "\"owner-a\"", "unknown"),
    ] {
        tree.journal(employee, owner, phase);
        assert!(storage_paths(&config, &session(A)).is_err());
        assert!(storage_paths(&config, &session(B)).is_ok()); // Current bindings skip the journal.
    }
    tree.company(
        &[
            row(E, B, "2", "true", "false"),
            row(F, C, "1", "true", "false"),
        ],
        &[],
    );
    tree.write(&tree.root.join("plan-moves.json"),&format!("[{{\"employeeId\":\"{E}\",\"owner\":\"owner-a\",\"oldSession\":\"{A}\",\"phase\":\"failed\"}},{{\"employeeId\":\"{F}\",\"owner\":\"owner-a\",\"newSession\":\"{A}\",\"phase\":\"completed\"}}]"));
    assert!(storage_paths(&config, &session(A)).is_err());
    tree.write(
        &tree.root.join("plan-moves.json"),
        "[{\"phase\":\"unknown\",\"employeeId\":false}]",
    );
    assert_eq!(
        storage_paths(&config, &session(A)).unwrap().kind(),
        StorageKind::Session
    );
}

#[test]
fn stored_lineage_survives_journal_pruning_and_rejects_reassignment_or_foreign_owner() {
    let tree = Tree::new();
    let config = tree.config();
    let first = storage_paths(&config, &session(A)).unwrap();
    tree.marker(A, E, "\"owner-a\"");
    tree.company(&[row(E, B, "2", "true", "false")], &[]);
    assert_eq!(storage_paths(&config, &session(A)).unwrap(), first);
    assert!(!storage_start_allowed(&config, &first).unwrap());
    tree.marker(A, E, "\"owner-b\"");
    assert!(storage_paths(&config, &session(A)).is_err());
    tree.marker(A, E, "\"owner-a\"");
    tree.company(
        &[
            row(E, B, "2", "true", "false"),
            row(F, A, "1", "true", "false"),
        ],
        &[],
    );
    assert!(storage_paths(&config, &session(A)).is_err());
    tree.company(&[row(E, B, "2", "true", "false")], &[]);
    let marker = tree.state().join(A).join("storage-owner.json");
    tree.write(
        &marker,
        &format!(
            "{{\"version\":1,\"employeeId\":\"{E}\",\"sessionId\":\"{B}\",\"owner\":\"owner-a\"}}"
        ),
    );
    assert!(storage_paths(&config, &session(A)).is_err());
    fs::remove_file(&marker).unwrap();
    symlink(tree.root.join("missing"), &marker).unwrap();
    assert!(storage_paths(&config, &session(A)).is_err());
}

#[test]
fn opaque_unrelated_records_are_not_globally_reinterpreted_as_uuid_identities() {
    let tree = Tree::new();
    let config = tree.config();
    tree.company(
        &[
            row(E, A, "1", "true", "false"),
            row("force-synthetic", C, "null", "true", "false"),
        ],
        &[],
    );
    assert_eq!(storage_paths(&config, &session(A)).unwrap().identity(), E);
    assert!(storage_paths(&config, &session(C)).is_err());
    assert_eq!(company_records(&config).unwrap().records().len(), 2);
    tree.company(
        &[
            row(E, A, "1", "true", "false"),
            row(E, B, "1", "true", "false"),
        ],
        &[],
    );
    assert!(storage_paths(&config, &session(A)).is_err());
    tree.company(
        &[row(E, A, "1", "true", "false")],
        &[row(F, A, "1", "true", "false")],
    );
    assert!(storage_paths(&config, &session(A)).is_err());
}

#[test]
fn start_flags_keep_python_truthiness_separate_from_current_gpu_identity() {
    let tree = Tree::new();
    let config = tree.config();
    for (running, vacation, expected) in [
        ("false", "false", false),
        ("true", "true", false),
        ("0", "0", true),
        ("null", "[]", true),
        ("\"\"", "{}", true),
        ("true", "\"false\"", false),
        ("true", "[0]", false),
        ("true", "NaN", false),
    ] {
        tree.company(&[row(E, A, "1", running, vacation)], &[]);
        let paths = storage_paths(&config, &session(A)).unwrap();
        assert_eq!(storage_start_allowed(&config, &paths).unwrap(), expected);
        assert!(current_employee(&config, &session(A)).unwrap().is_some());
    }
    let old = storage_paths(&config, &session(A)).unwrap();
    tree.company(&[row(F, A, "1", "true", "false")], &[]);
    assert!(!storage_start_allowed(&config, &old).unwrap());
}

#[test]
fn current_gpu_generation_is_positive_unbounded_integer_and_rechecks_drift() {
    let tree = Tree::new();
    let config = tree.config();
    let huge = "999999999999999999999999999999999999999999999999999999999999999999";
    tree.company(&[row(E, A, huge, "false", "true")], &[]);
    assert_eq!(
        current_employee(&config, &session(A))
            .unwrap()
            .unwrap()
            .generation()
            .decimal(),
        huge
    );
    for generation in ["0", "-1", "true", "1.0", "null"] {
        tree.company(&[row(E, A, generation, "true", "false")], &[]);
        assert!(current_employee(&config, &session(A)).is_err());
    }
    tree.company(&[row(E, A, "1", "true", "false")], &[]);
    let company = tree.company_file();
    inject(move |point, _| {
        if matches!(point, Point::CurrentSelected) {
            fs::write(
                &company,
                format!("{{\"employees\":[{}]}}", row(E, A, "2", "true", "false")),
            )
            .unwrap();
        }
        Ok(())
    });
    assert_eq!(
        current_employee(&config, &session(A)).unwrap_err().code(),
        "CURRENT_EMPLOYEE_BINDING_CHANGED"
    );
}

#[test]
fn storage_owner_change_during_gpu_recheck_never_returns_the_old_current_fact() {
    let tree = Tree::new();
    let config = tree.config();
    let company = tree.company_file();
    inject(move |point, _| {
        if matches!(point, Point::CurrentSelected) {
            fs::write(
                &company,
                format!("{{\"employees\":[{}]}}", row(F, A, "1", "true", "false")),
            )
            .unwrap();
        }
        Ok(())
    });
    assert_eq!(
        current_employee(&config, &session(A)).unwrap_err().code(),
        "CURRENT_EMPLOYEE_BINDING_CHANGED"
    );
}
