use super::*;
fn config(fixture: &Fixture, source: &Path) -> ReservationConfiguration {
    let value = json!({"stateRoot":fixture.root.join("state"),"resourceReservations":{"directory":fixture.root.join("control")},"mounts":[{"source":source}]});
    ReservationConfiguration::capture(
        worker_config::decode(&serde_json::to_vec(&value).unwrap()).unwrap(),
    )
}
fn mount_table(extra: &str) -> MountTable {
    MountTable::parse(
        &format!("1 0 0:1 / / rw - ext4 dev rw\n{extra}")
            .chars()
            .map(u32::from)
            .collect::<Vec<_>>(),
    )
    .unwrap()
}
#[test]
fn future_markers_protect_precise_leaves_and_resolved_aliases_remain_excluded() {
    let fixture = Fixture::new();
    let workspace = fixture.root.join("work");
    fs::create_dir(&workspace).unwrap();
    let rows = fixture.row();
    assert!(
        custody::scan(
            &fixture,
            &config(&fixture, &workspace),
            &rows,
            &mount_table(""),
            end()
        )
        .is_ok()
    );
    assert_eq!(
        custody::scan(
            &fixture,
            &config(&fixture, &fixture.root),
            &rows,
            &mount_table(""),
            end()
        )
        .err()
        .unwrap()
        .code(),
        "RESERVATION_CONTROL_EXPOSED"
    );
    let control = fixture.root.join("control");
    fs::create_dir(&control).unwrap();
    let alias = fixture.root.join("alias");
    std::os::unix::fs::symlink(control, &alias).unwrap();
    assert_eq!(
        custody::scan(
            &fixture,
            &config(&fixture, &alias),
            &rows,
            &mount_table(""),
            end()
        )
        .err()
        .unwrap()
        .code(),
        "RESERVATION_CONTROL_EXPOSED"
    );
}
#[test]
fn same_device_mount_coordinates_nested_roots_and_mount_location_mismatch_refuse() {
    let fixture = Fixture::new();
    let workspace = fixture.root.join("work");
    fs::create_dir(&workspace).unwrap();
    let rows = fixture.row();
    let config = config(&fixture, &workspace);
    let root = fixture.root.join("control");
    let extra = format!(
        "3 1 0:1 {} {} rw - ext4 dev rw\n",
        root.display(),
        workspace.display()
    );
    fixture.mount_locations.borrow_mut().push((
        PosixPath::try_new(&native::python_text(&workspace)).unwrap(),
        UnsignedInteger::from_u64(3),
        MountDevice::from_native(0, 1),
    ));
    assert_eq!(
        custody::scan(&fixture, &config, &rows, &mount_table(&extra), end())
            .err()
            .unwrap()
            .code(),
        "RESERVATION_CONTROL_ALIAS"
    );
    fixture.mount_locations.borrow_mut().clear();
    let extra = format!(
        "3 1 0:1 {} {}/nested rw - ext4 dev rw\n",
        root.display(),
        workspace.display()
    );
    assert_eq!(
        custody::scan(&fixture, &config, &rows, &mount_table(&extra), end())
            .err()
            .unwrap()
            .code(),
        "RESERVATION_NESTED_CONTROL_ALIAS"
    );
    let extra = format!(
        "3 1 0:1 opaque {}/nested rw - nsfs dev rw\n",
        workspace.display()
    );
    assert_eq!(
        custody::scan(&fixture, &config, &rows, &mount_table(&extra), end())
            .err()
            .unwrap()
            .code(),
        "RESERVATION_NESTED_CONTROL_ALIAS"
    );
    fixture.mount_locations.borrow_mut().push((
        PosixPath::try_new(&native::python_text(&workspace)).unwrap(),
        UnsignedInteger::from_u64(1),
        MountDevice::from_native(9, 9),
    ));
    assert_eq!(
        custody::scan(&fixture, &config, &rows, &mount_table(""), end())
            .err()
            .unwrap()
            .code(),
        "RESERVATION_NATIVE_MOUNT_BINDING"
    );
}
