use reverie_core::worker_schema::{
    MountTarget, RootlessMount, WorkerIds, require_account_mounts, require_immutable_mounts,
};
fn target(value: &str) -> MountTarget {
    MountTarget::try_new(value.chars().map(u32::from).collect()).unwrap()
}
#[test]
fn canonical_posix_targets_are_not_native_paths_or_character_allowlists() {
    for value in ["/", "/workspace", "/x\0y", "/x\ny"] {
        assert!(MountTarget::try_new(value.chars().map(u32::from).collect()).is_ok());
    }
    assert!(MountTarget::try_new(vec![47, 0xd800]).is_ok());
    for value in [
        "", "relative", "//root", "/a//b", "/a/./b", "/a/../b", "/a/",
    ] {
        assert!(MountTarget::try_new(value.chars().map(u32::from).collect()).is_err());
    }
}
#[test]
fn account_targets_require_strict_roots_and_disjointness_without_extra_name_rules() {
    let workspace = target("/workspace");
    let base = [&workspace];
    for value in [
        "/instances/default/accounts/a",
        "/instances/default/console/accounts/a",
        "/instances/default/accounts/a\0b",
    ] {
        assert!(require_account_mounts(&base, &[target(value)]).is_ok());
    }
    for value in [
        "/instances/default/accounts",
        "/instances/default/accounts-other/a",
        "/workspace/a",
    ] {
        assert!(require_account_mounts(&base, &[target(value)]).is_err());
    }
    let a = target("/instances/default/accounts/a");
    let child = target("/instances/default/accounts/a/child");
    assert!(require_account_mounts(&base, &[a.clone(), a]).is_err());
    assert!(
        require_account_mounts(&base, &[target("/instances/default/accounts/a"), child]).is_err()
    );
}
#[test]
fn checked_ids_and_rootless_overlap_do_not_grant_a_native_identity() {
    assert!(WorkerIds::try_new(1, i32::MAX as u32).is_ok());
    for value in [0, i32::MAX as u32 + 1, u32::MAX] {
        assert!(WorkerIds::try_new(value, 1).is_err());
    }
    let parent = target("/projects");
    let child = target("/projects/child");
    assert!(
        require_immutable_mounts(&[
            RootlessMount {
                target: &parent,
                read_only_is_true: false
            },
            RootlessMount {
                target: &child,
                read_only_is_true: true
            }
        ])
        .is_err()
    );
}
