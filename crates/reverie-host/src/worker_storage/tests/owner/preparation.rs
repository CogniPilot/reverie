use super::*;
fn source(tree: &Tree, workspace: bool) -> EffectiveWorkerConfig {
    let mut raw: Value =
        serde_json::from_slice(&worker_config::encode_config(&selected(tree))).unwrap();
    if workspace {
        raw["mounts"] =
            json!([{"source":tree.0.join("shared"),"destination":"/reverie_workspace"}]);
    }
    config(raw)
}
fn native_recipe(tree: &Tree, owner: &mut LaunchStorage, recipe: &str) {
    if recipe == "record-no-company" {
        stdfs::remove_file(tree.0.join("company.json")).unwrap();
        owner.record_storage_binding().unwrap();
        return;
    }
    owner.prepare_storage().unwrap();
    if matches!(recipe, "occupied-owner" | "repeat") {
        tree.write(
            &owner.paths().home().join("AGENTS.md"),
            "Owner guidance\r\nKeep Ω results.\r\n".as_bytes(),
        );
        tree.write(
            &owner.paths().home().join("workspace"),
            b"occupied owner workspace",
        );
    }
    owner.record_storage_binding().unwrap();
    let target = owner.prepare_temporary().unwrap();
    tree.write(&target.join("owner-result"), b"retained task evidence");
    owner.home_workspace_alias().unwrap();
    owner.write_storage_instructions().unwrap();
    if recipe == "repeat" {
        owner.prepare_storage().unwrap();
        owner.record_storage_binding().unwrap();
        owner.prepare_temporary().unwrap();
        owner.home_workspace_alias().unwrap();
        owner.write_storage_instructions().unwrap();
    }
    owner.validate_storage().unwrap();
}
#[test]
fn actual_unleased_legacy_recipes_preserve_full_bytes_modes_aliases_and_no_lock_tree() {
    let corpus: Value = serde_json::from_str(include_str!(
        "../../fixtures/legacy-owner-preparation-python.json"
    ))
    .unwrap();
    assert_eq!(corpus["cases"].as_array().unwrap().len(), 5);
    for case in corpus["cases"].as_array().unwrap() {
        let tree = Tree::new();
        tree.write(
            &tree.0.join("company.json"),
            corpus["companyText"].as_str().unwrap().as_bytes(),
        );
        let runtime = runtime(&tree);
        let source = source(&tree, case["workspace"].as_bool().unwrap());
        let mut owner = runtime
            .resolve_storage(&source, &session(B))
            .unwrap()
            .into_legacy()
            .unwrap();
        assert_eq!(owner.ownership_kind(), StorageOwnershipKind::UnleasedLegacy);
        native_recipe(&tree, &mut owner, case["recipe"].as_str().unwrap());
        assert!(
            !tree.state().join("storage-locks").exists(),
            "legacy preparation never fabricates a lock"
        );
        let mut actual = Vec::new();
        super::super::compatibility::snapshot(&tree.0, &tree.0, &mut actual).unwrap();
        assert_eq!(Value::Array(actual), case["snapshot"], "{}", case["recipe"]);
        owner.close(end()).unwrap();
        runtime.close(end()).unwrap();
    }
}
#[test]
fn legacy_prepare_refuses_fresh_binding_drift_without_adding_employee_lock_or_storage() {
    let tree = Tree::new();
    let runtime = runtime(&tree);
    let source = selected(&tree);
    let mut owner = runtime
        .resolve_storage(&source, &session(B))
        .unwrap()
        .into_legacy()
        .unwrap();
    tree.company(B, "null", true);
    assert!(owner.prepare_storage().is_err());
    assert!(!tree.state().exists());
    assert_eq!(owner.ownership_kind(), StorageOwnershipKind::UnleasedLegacy);
    owner.close(end()).unwrap();
    runtime.close(end()).unwrap();
}
#[test]
fn consumed_unconfirmed_owner_refuses_every_fixed_preparation_without_new_effects() {
    if crate::test_process::isolate_case(
        "worker_storage::tests::owner::preparation::consumed_unconfirmed_owner_refuses_every_fixed_preparation_without_new_effects",
    ) {
        return;
    }
    let tree = Tree::new();
    let runtime = runtime(&tree);
    let source = selected(&tree);
    let owner = runtime
        .resolve_storage(&source, &session(A))
        .unwrap()
        .acquire()
        .unwrap();
    native::test_faults::set(None, true);
    let (mut owner, _) = owner.close(end()).unwrap_err().into_parts();
    let mut before = Vec::new();
    super::super::compatibility::snapshot(&tree.0, &tree.0, &mut before).unwrap();
    assert_eq!(
        owner.prepare_storage().unwrap_err().code(),
        "WORKER_STORAGE_CLOSE_UNCONFIRMED"
    );
    assert_eq!(
        owner.record_storage_binding().unwrap_err().code(),
        "WORKER_STORAGE_CLOSE_UNCONFIRMED"
    );
    assert_eq!(
        owner.prepare_temporary().unwrap_err().code(),
        "WORKER_STORAGE_CLOSE_UNCONFIRMED"
    );
    assert_eq!(
        owner.home_workspace_alias().unwrap_err().code(),
        "WORKER_STORAGE_CLOSE_UNCONFIRMED"
    );
    assert_eq!(
        owner.write_storage_instructions().unwrap_err().code(),
        "WORKER_STORAGE_CLOSE_UNCONFIRMED"
    );
    assert_eq!(
        owner.validate_storage().unwrap_err().code(),
        "WORKER_STORAGE_CLOSE_UNCONFIRMED"
    );
    let mut after = Vec::new();
    super::super::compatibility::snapshot(&tree.0, &tree.0, &mut after).unwrap();
    assert_eq!(before, after);
    runtime.close(end()).unwrap();
}
