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
    fs::DirBuilder::new().recursive(true).mode(0o700).create(state.folder()).unwrap();
    let selection = state.folder().join("environment");
    fs::write(&selection, environment(&state.source).unwrap()).unwrap();
    fs::set_permissions(&selection, fs::Permissions::from_mode(0o600)).unwrap();
    let native = state.observe().and_then(|view| state.assert_installed(&view));
    let closed = state.close();
    fs::remove_file(selection).unwrap();
    fs::remove_file(root.join("manager-fragment-link")).unwrap();
    cleanup_predecessor(root, program);
    assert!(closed.is_ok());
    assert!(predecessor.is_ok(), "{predecessor:?}");
    assert!(replaceable.is_ok(), "{replaceable:?}");
    assert!(native.is_ok(), "{native:?}");
}
