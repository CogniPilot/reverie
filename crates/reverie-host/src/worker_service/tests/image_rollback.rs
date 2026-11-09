use super::*;
use sha2::Digest;

fn selected_source(current: &[u8], corrupt_backup: bool) -> (State, PathBuf, PathBuf) {
    let (state, root, program) = rollback_fixture();
    let original = br#"{"owned":"same policy","image":"old-image"}"#;
    fs::write(&state.source, current).unwrap();
    let digest = format!("{:x}", sha2::Sha256::digest(original));
    fs::write(state.folder().join("source-sha256"), digest).unwrap();
    write_owned_test(&state.folder().join("source-original.json"), original);
    if corrupt_backup {
        fs::write(
            state.folder().join("source-original.json"),
            br#"{"owned":"foreign","image":"old-image"}"#,
        )
        .unwrap();
    }
    (state, root, program)
}

#[test]
fn code_rollback_keeps_a_current_image_only_selection_and_restores_previous_unit() {
    let current = br#"{"owned":"same policy","image":"new-native-child-image"}"#;
    let (mut state, root, _program) = selected_source(current, false);
    let body = state.run(WorkerServiceAction::Rollback {
        start_previous: false,
    });
    let closed = state.close();
    let finish = if body.is_ok() && closed.is_ok() {
        state.finish_attempt()
    } else {
        Ok(())
    };
    let selected = fs::read_link(state.home.join(".config/systemd/user").join(UNIT)).unwrap();
    let after = fs::read(&state.source).unwrap();
    fs::remove_dir_all(root).unwrap();
    assert!(body.is_ok(), "{body:?}");
    assert!(closed.is_ok() && finish.is_ok());
    assert_eq!(Some(selected), state.previous);
    assert_eq!(after, current);
}

#[test]
fn code_rollback_refuses_non_image_policy_changes_and_a_corrupt_original() {
    for (current, corrupt) in [
        (
            br#"{"owned":"changed policy","image":"new-native-child-image"}"#.as_slice(),
            false,
        ),
        (
            br#"{"owned":"same policy","image":"new-native-child-image"}"#.as_slice(),
            true,
        ),
    ] {
        let (mut state, root, _program) = selected_source(current, corrupt);
        let body = state.run(WorkerServiceAction::Rollback {
            start_previous: false,
        });
        let closed = state.close();
        let selected = fs::read_link(state.home.join(".config/systemd/user").join(UNIT)).unwrap();
        let pending = state.folder().join("pending").exists();
        fs::remove_dir_all(root).unwrap();
        assert!(body.is_err());
        assert!(closed.is_ok());
        assert_eq!(selected, state.unit);
        assert!(!pending);
    }
}
