use super::*;
use reverie_contracts::reservation_engine::CustodyInventory;
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

#[test]
fn selected_real_control_binding_changes_only_the_targets_not_mount_policy() {
    let fixture = Fixture::new();
    let workspace = fixture.root.join("work");
    fs::create_dir(&workspace).unwrap();
    let rows = fixture.row();
    let config = config(&fixture, &workspace);
    let defaults = CustodyPaths::control(&config).unwrap();
    custody::scan_targets(&fixture, &config, &defaults, &rows, &mount_table(""), end()).unwrap();
    let selected = CustodyPaths::declared(
        config.control_paths().unwrap().root().clone(),
        PosixPath::try_new(&native::python_text(&workspace.join("owner.json"))).unwrap(),
    )
    .unwrap();
    assert_eq!(
        custody::scan_targets(&fixture, &config, &selected, &rows, &mount_table(""), end())
            .unwrap_err()
            .code(),
        "RESERVATION_CONTROL_EXPOSED"
    );
    // Same-source native mount-location and alias policies still run for
    // selected targets, including a not-yet-created pending sibling.
    let safe = fixture.root.join("private/config.json");
    let safe = CustodyPaths::declared(
        config.control_paths().unwrap().root().clone(),
        PosixPath::try_new(&native::python_text(&safe)).unwrap(),
    )
    .unwrap();
    fixture.mount_locations.borrow_mut().push((
        PosixPath::try_new(&native::python_text(&workspace)).unwrap(),
        UnsignedInteger::from_u64(1),
        MountDevice::from_native(9, 9),
    ));
    assert_eq!(
        custody::scan_targets(&fixture, &config, &safe, &rows, &mount_table(""), end())
            .unwrap_err()
            .code(),
        "RESERVATION_NATIVE_MOUNT_BINDING"
    );
}

fn stopped_mounts(mounts: serde_json::Value) -> (InventoryRows, serde_json::Value) {
    let id = "2".repeat(64);
    let ordinary = json!({"Id":id,"Name":"/retired-controller","Image":format!("sha256:{}","a".repeat(64)),
        "Config":{"Labels":{}},"HostConfig":{},"State":{"Running":false,"Pid":0},"Mounts":mounts});
    let rows =
        InventoryRows::decode(&inventory_ids(&id).unwrap(), &[ordinary.to_string()]).unwrap();
    let mut extended = ordinary;
    extended["State"] = json!({"Running":false,"Pid":0,"Status":"exited","StartedAt":"old",
        "Paused":false,"Restarting":false,"Dead":false});
    (rows, extended)
}

#[test]
fn retired_missing_mounts_require_fresh_stopped_state_and_still_guard_future_aliases() {
    let fixture = Fixture::new();
    let workspace = fixture.root.join("work");
    fs::create_dir(&workspace).unwrap();
    let policy = config(&fixture, &workspace);
    let targets = CustodyPaths::control(&policy).unwrap();
    let missing = fixture.root.join("retired/control");
    let (rows, extended) = stopped_mounts(json!([{"Source":missing}]));
    let mut inventory = CustodyInventory::new(&rows);
    let scan = |inventory: &CustodyInventory<'_>| {
        custody::scan_with_stopped(
            &fixture,
            &policy,
            &targets,
            inventory,
            &mount_table(""),
            end(),
        )
    };
    assert!(matches!(
        scan(&inventory),
        Err(ReservationKernelError::StoppedMountStateRequired(_))
    ));
    let id = rows.rows()[0].id();
    inventory
        .observe_stopped(id, &extended.to_string())
        .unwrap();
    scan(&inventory).unwrap();
    for (field, value) in [
        ("Running", json!(true)),
        ("Paused", json!(true)),
        ("Restarting", json!(true)),
        ("Dead", json!(true)),
        ("Status", json!("removing")),
        ("Status", json!(12)),
        ("Pid", json!(9)),
    ] {
        let mut changed = extended.clone();
        changed["State"][field] = value;
        assert!(
            inventory
                .assert_stopped_current(id, &changed.to_string())
                .is_err()
        );
        assert!(
            CustodyInventory::new(&rows)
                .observe_stopped(id, &changed.to_string())
                .is_err()
        );
    }
    // A dangling alias into a protected future path must still be refused.
    let alias = fixture.root.join("future-alias");
    std::os::unix::fs::symlink(fixture.root.join("control"), &alias).unwrap();
    let (rows, extended) = stopped_mounts(json!([{"Source":alias.join("future")} ]));
    let mut inventory = CustodyInventory::new(&rows);
    inventory
        .observe_stopped(rows.rows()[0].id(), &extended.to_string())
        .unwrap();
    assert_eq!(
        scan(&inventory).unwrap_err().code(),
        "RESERVATION_CONTROL_EXPOSED"
    );
    // Running missing sources and configured missing sources remain errors.
    let running = fixture.row_with_mounts(json!([{"Source":missing}]));
    assert!(matches!(
        scan(&CustodyInventory::new(&running)),
        Err(ReservationKernelError::Observation(_))
    ));
    assert!(
        custody::scan(
            &fixture,
            &config(&fixture, &missing),
            &fixture.row(),
            &mount_table(""),
            end()
        )
        .is_err()
    );
}
