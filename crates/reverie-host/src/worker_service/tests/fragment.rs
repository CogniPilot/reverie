use super::*;
use std::os::unix::fs::PermissionsExt;

#[test]
fn actual_manager_named_symlink_preserves_exact_predecessor_and_native_identity() {
    let (mut state, root, program) = fixture_mode("native-worker-manager-rollback");
    prepare_predecessor(&state);
    fs::write(root.join("manager-fragment-link"), b"fixed named unit").unwrap();
    let observed = state.observe().unwrap();
    let predecessor = state.assert_stoppable(&observed);
    let replaceable = observed.require_replaceable(state.previous.as_deref());
    let link = root.join(".config/systemd/user").join(UNIT);
    fs::remove_file(&link).unwrap();
    std::os::unix::fs::symlink(&state.unit, &link).unwrap();
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(state.folder())
        .unwrap();
    let selection = state.folder().join("environment");
    fs::write(&selection, environment(&state.source).unwrap()).unwrap();
    fs::set_permissions(&selection, fs::Permissions::from_mode(0o600)).unwrap();
    let native = state
        .observe()
        .and_then(|view| state.assert_installed(&view));
    let closed = state.close();
    fs::remove_file(selection).unwrap();
    fs::remove_file(root.join("manager-fragment-link")).unwrap();
    cleanup_predecessor(root, program);
    assert!(closed.is_ok());
    assert!(predecessor.is_ok(), "{predecessor:?}");
    assert!(replaceable.is_ok(), "{replaceable:?}");
    assert!(native.is_ok(), "{native:?}");
}

#[test]
fn named_fragment_needs_current_manager_and_exact_owned_selected_link() {
    let raw = "LoadState=loaded\nActiveState=inactive\nSubState=dead\nFragmentPath=/nix/store/old-worker/share/systemd/user/reverie-worker-broker.service\nDropInPaths=\nNeedDaemonReload=no\n";
    assert!(ObservedUnit::decode(&raw.replace("NeedDaemonReload=no\n", "")).is_err());
    assert!(
        ObservedUnit::decode(&raw.replace("NeedDaemonReload=no", "NeedDaemonReload=yes")).is_err()
    );
    let (mut state, root, program) = fixture_mode("native-worker-manager-rollback");
    prepare_predecessor(&state);
    fs::write(root.join("manager-fragment-link"), b"fixed named unit").unwrap();
    let link = root.join(".config/systemd/user").join(UNIT);
    fs::remove_file(&link).unwrap();
    std::os::unix::fs::symlink("/nix/store/foreign/unit", &link).unwrap();
    let foreign = state.observe();
    fs::remove_file(&link).unwrap();
    std::os::unix::fs::symlink(state.previous.as_ref().unwrap(), &link).unwrap();
    let duplicate = link.with_file_name("duplicate.service");
    fs::hard_link(&link, &duplicate).unwrap();
    let hardlinked = state.observe();
    fs::remove_file(duplicate).unwrap();
    let mut aliased = state.observe().unwrap();
    aliased.fragment = root.join("other.service");
    let alias = state.assert_stoppable(&aliased);
    let closed = state.close();
    fs::remove_file(root.join("manager-fragment-link")).unwrap();
    cleanup_predecessor(root, program);
    assert!(closed.is_ok());
    assert!(foreign.is_err());
    assert!(hardlinked.is_err());
    assert!(alias.is_err());
}
