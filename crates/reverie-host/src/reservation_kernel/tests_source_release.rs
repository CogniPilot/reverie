use super::*;
use reverie_contracts::{
    reservation_baseline::{OriginalBaselineFields, OriginalSourceBaseline},
    reservation_engine::NativeStorageBinding,
};
fn capture(fixture: &Fixture) -> OriginalSourceBaseline {
    let rows = fixture.row();
    let row = &rows.rows()[0];
    let limits = limits::observe(fixture, row, None, end()).unwrap();
    let native = limits.binding();
    let runtime = baseline::observe(fixture, row, native, end()).unwrap();
    let number = UnsignedInteger::from_u64(0);
    OriginalSourceBaseline::from_observed_data(OriginalBaselineFields {
        source: row,
        native,
        storage: &NativeStorageBinding::from_observed_data([[1; 4]; 3]),
        site: native,
        commitments: &[],
        total: &number,
        budget: &number,
        runtime: &runtime,
    })
}
fn stopped() -> InventoryRows {
    let id = "1".repeat(64);
    InventoryRows::decode(
        &inventory_ids(&id).unwrap(),
        &[json!({"Id":id,"State":{"Running":false,"Pid":0},"Mounts":[]}).to_string()],
    )
    .unwrap()
}
#[test]
fn old_pid_must_be_missing_or_a_different_incarnation_before_and_after_events() {
    let fixture = Fixture::new();
    let baseline = capture(&fixture);
    let rows = stopped();
    let row = &rows.rows()[0];
    assert_eq!(
        source_release::observe(&fixture, row, &baseline, end())
            .unwrap_err()
            .code(),
        "RESOURCE_NATIVE_OLD_PROCESS_ALIVE"
    );
    fixture.write(
        "/proc/123/stat",
        format!("1 (owned fixture) S {} 78", "0 ".repeat(18)).as_bytes(),
    );
    fixture.write(
        "/sys/fs/cgroup/worker/cgroup.events",
        b"populated 0\nfrozen 0\n",
    );
    source_release::observe(&fixture, row, &baseline, end()).unwrap();
    fs::remove_file(fixture.actual(&path("/proc/123/stat"))).unwrap();
    *fixture.hook.borrow_mut() = Some(Box::new(|fixture, selected| {
        assert_eq!(*selected, path("/sys/fs/cgroup/worker/cgroup.events"));
        fixture.write(
            "/proc/123/stat",
            format!("1 (owned fixture) S {} 77", "0 ".repeat(18)).as_bytes(),
        );
    }));
    assert_eq!(
        source_release::observe(&fixture, row, &baseline, end())
            .unwrap_err()
            .code(),
        "RESOURCE_NATIVE_OLD_PROCESS_ALIVE"
    );
}
#[test]
fn populated_rebound_missing_and_nonascii_cgroup_cases_keep_source_error_order() {
    let fixture = Fixture::new();
    let baseline = capture(&fixture);
    let rows = stopped();
    let row = &rows.rows()[0];
    fs::remove_file(fixture.actual(&path("/proc/123/stat"))).unwrap();
    for (raw, code) in [
        (
            b"populated 1\n".as_slice(),
            "RESOURCE_NATIVE_OLD_CGROUP_POPULATED",
        ),
        (
            b"populated 0\npopulated 0\n",
            "RESOURCE_NATIVE_OLD_CGROUP_UNKNOWN",
        ),
        (b"populated \xff\n", "RESERVATION_NATIVE_ENCODING"),
        (b"", "RESOURCE_NATIVE_OLD_CGROUP_POPULATED"),
    ] {
        fixture.write("/sys/fs/cgroup/worker/cgroup.events", raw);
        assert_eq!(
            source_release::observe(&fixture, row, &baseline, end())
                .unwrap_err()
                .code(),
            code
        );
    }
    fixture.write(
        "/sys/fs/cgroup/worker/cgroup.events",
        b"populated 000\nunknown 42\n",
    );
    source_release::observe(&fixture, row, &baseline, end()).unwrap();
    let group = fixture.actual(&path("/sys/fs/cgroup/worker"));
    fs::rename(&group, group.with_file_name("preserved-group")).unwrap();
    source_release::observe(&fixture, row, &baseline, end()).unwrap();
    fs::create_dir(&group).unwrap();
    assert_eq!(
        source_release::observe(&fixture, row, &baseline, end())
            .unwrap_err()
            .code(),
        "RESOURCE_NATIVE_OLD_CGROUP_CHANGED"
    );
}
#[test]
fn inaccessible_cgroup_is_not_false_absence_even_when_old_pid_is_missing() {
    let fixture = Fixture::new();
    let baseline = capture(&fixture);
    let rows = stopped();
    let row = &rows.rows()[0];
    assert_ne!(
        fs::metadata(&fixture.root).unwrap().uid(),
        0,
        "owned EACCES control requires an unprivileged test owner"
    );
    fs::remove_file(fixture.actual(&path("/proc/123/stat"))).unwrap();
    fixture.write("/sys/fs/cgroup/worker/cgroup.events", b"populated 1\n");
    let parent = fixture.actual(&path("/sys/fs/cgroup"));
    fs::set_permissions(&parent, fs::Permissions::from_mode(0o000)).unwrap();
    let result = source_release::observe(&fixture, row, &baseline, end());
    fs::set_permissions(&parent, fs::Permissions::from_mode(0o700)).unwrap();
    let error = result.unwrap_err();
    assert!(
        matches!(error,ReservationKernelError::Observation(ObservationError::Io(ref cause)) if cause.kind()==io::ErrorKind::PermissionDenied)
    );
}
