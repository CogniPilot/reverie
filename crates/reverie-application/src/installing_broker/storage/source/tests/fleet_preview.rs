//! Genuine recovered Offices/Boxes. Preview observations do not stop, borrow
//! Source resources, mutate company intent or manufacture a registered owner.
use super::*;

#[test]
fn lifecycle_observation_retains_original_office_and_refuses_equal_foreign_registration() {
    crate::test_process::owning_case!(
        lifecycle_observation_retains_original_office_and_refuses_equal_foreign_registration
    );
    let first = employee_tree();
    let second = employee_tree();
    let snapshot = first.broker.installed.capture_fleet_preview().unwrap();
    let known = snapshot.assert_current(&first.broker.installed);
    let before = fs::read(first.root.join("calls.txt")).unwrap();
    {
        let mut a = first.broker.installed.lifecycle().unwrap();
        let mut b = second.broker.installed.lifecycle().unwrap();
        assert_eq!(a.guard[0].session, b.guard[0].session);
        assert_eq!(a.guard[0].name, b.guard[0].name);
        std::mem::swap(&mut a.guard[0], &mut b.guard[0]);
    }
    let replaced = snapshot.assert_current(&first.broker.installed);
    {
        let mut a = first.broker.installed.lifecycle().unwrap();
        let mut b = second.broker.installed.lifecycle().unwrap();
        std::mem::swap(&mut a.guard[0], &mut b.guard[0]);
    }
    let original = snapshot.assert_current(&first.broker.installed);
    let foreign = snapshot.assert_current(&second.broker.installed);
    let unchanged = fs::read(first.root.join("calls.txt")).unwrap() == before;
    drop(snapshot);
    known.unwrap();
    original.unwrap();
    assert!(replaced.is_err() && foreign.is_err() && unchanged);
}

#[test]
fn readonly_lifecycle_observation_refuses_busy_original_lock_without_native_dispatch() {
    crate::test_process::owning_case!(
        readonly_lifecycle_observation_refuses_busy_original_lock_without_native_dispatch
    );
    let tree = employee_tree();
    let before = fs::read(tree.root.join("calls.txt")).unwrap();
    let held = tree.broker.installed.lifecycle().unwrap();
    let busy = tree.broker.installed.capture_fleet_preview().err().unwrap();
    drop(held);
    let snapshot = tree.broker.installed.capture_fleet_preview().unwrap();
    let original = snapshot.assert_current(&tree.broker.installed);
    let unchanged = fs::read(tree.root.join("calls.txt")).unwrap() == before;
    drop(snapshot);
    original.unwrap();
    assert_eq!(busy.code(), "FLEET_PREVIEW_LIFECYCLE_UNAVAILABLE");
    assert!(unchanged);
}
