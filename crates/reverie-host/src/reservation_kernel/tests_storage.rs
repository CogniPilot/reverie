use super::*;
use reverie_core::ids::ProfileSessionId;
use reverie_store::storage_identity::{self, StorageIdentityConfig};
use serde_json::json;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
fn setup(
    fixture: &Fixture,
) -> (
    ReservationConfiguration,
    InventoryRows,
    storage_identity::StoragePaths,
) {
    let state = fixture.root.join("state");
    let scratch = fixture.root.join("scratch");
    let company = fixture.root.join("company.json");
    fs::write(&company, b"{\"employees\":[],\"retired\":[]}").unwrap();
    fs::set_permissions(&company, fs::Permissions::from_mode(0o600)).unwrap();
    let uid = fs::metadata(&fixture.root).unwrap().uid();
    let config =
        StorageIdentityConfig::try_new(company, state.clone(), scratch.clone(), uid).unwrap();
    let paths = storage_identity::storage_paths(
        &config,
        &ProfileSessionId::parse("00000000-0000-0000-0000-000000000000").unwrap(),
    )
    .unwrap();
    let selected = [
        ("/home/agent", paths.home()),
        ("/nix", paths.nix()),
        ("/scratch", paths.scratch()),
    ];
    for (dest, source) in selected {
        fs::create_dir_all(source).unwrap();
        fixture.identity_paths.borrow_mut().insert(
            path(&format!("/proc/123/root{dest}")).codepoints(),
            PosixPath::try_new(&native::python_text(source)).unwrap(),
        );
    }
    let id = "a".repeat(64);
    let mounts = selected
        .into_iter()
        .map(|(dest, source)| json!({"Type":"bind","RW":true,"Destination":dest,"Source":source}))
        .collect::<Vec<_>>();
    let row = json!({"Id":id,"State":{"Pid":123,"Running":true},"Mounts":mounts});
    let rows = InventoryRows::decode(&inventory_ids(&id).unwrap(), &[row.to_string()]).unwrap();
    let config = json!({"stateRoot":state,"scratchRoot":scratch,"uid":uid});
    (
        ReservationConfiguration::capture(
            worker_config::decode(&serde_json::to_vec(&config).unwrap()).unwrap(),
        ),
        rows,
        paths,
    )
}
#[test]
fn exact_storage_bindings_include_all_four_native_fields_and_process_visible_aliases() {
    let fixture = Fixture::new();
    let (config, rows, paths) = setup(&fixture);
    let observed = storage::observe(&fixture, &config, &rows.rows()[0], &paths, end()).unwrap();
    let data: serde_json::Value =
        serde_json::from_slice(&observed.binding().canonical_bytes()).unwrap();
    let metadata = fs::metadata(paths.home()).unwrap();
    assert_eq!(
        data["/home/agent"],
        json!([
            metadata.dev(),
            metadata.ino(),
            metadata.uid(),
            metadata.gid()
        ])
    );
    fixture.identity_paths.borrow_mut().insert(
        path("/proc/123/root/home/agent").codepoints(),
        PosixPath::try_new(&native::python_text(paths.nix())).unwrap(),
    );
    assert_eq!(
        storage::observe(&fixture, &config, &rows.rows()[0], &paths, end())
            .err()
            .unwrap()
            .code(),
        "RESERVATION_NATIVE_STORAGE_IDENTITY"
    );
}
#[test]
fn storage_rechecks_source_inode_and_raw_mount_source_without_normalizing_away_drift() {
    let fixture = Fixture::new();
    let (config, rows, paths) = setup(&fixture);
    let home = paths.home().to_owned();
    *fixture.identity_hook.borrow_mut() = Some(Box::new(move |_, _| {
        fs::rename(&home, home.with_file_name("old-home")).unwrap();
        fs::create_dir(&home).unwrap();
    }));
    assert_eq!(
        storage::observe(&fixture, &config, &rows.rows()[0], &paths, end())
            .err()
            .unwrap()
            .code(),
        "RESERVATION_NATIVE_STORAGE_IDENTITY"
    );
    let id = "b".repeat(64);
    let row = json!({"Id":id,"State":{"Pid":123,"Running":true},"Mounts":[{"Type":"bind","RW":true,"Destination":"/home/agent","Source":format!("{}/.",paths.home().display())}]});
    let rows = InventoryRows::decode(&inventory_ids(&id).unwrap(), &[row.to_string()]).unwrap();
    assert_eq!(
        storage::observe(&fixture, &config, &rows.rows()[0], &paths, end())
            .err()
            .unwrap()
            .code(),
        "RESERVATION_NATIVE_STORAGE_BINDING"
    );
}
#[test]
fn worker_identity_keeps_legacy_refusal_of_raw_state_and_scratch_alias_spelling() {
    let fixture = Fixture::new();
    let (_, _, paths) = setup(&fixture);
    let mut config = json!({"companyFile":fixture.root.join("company.json"),"stateRoot":fixture.root.join("state"),"scratchRoot":fixture.root.join("scratch"),"uid":fs::metadata(&fixture.root).unwrap().uid()});
    let settings = |value: &serde_json::Value| {
        reverie_contracts::resource_config::ResourceConfiguration::capture(
            worker_config::decode(&serde_json::to_vec(value).unwrap()).unwrap(),
        )
        .unwrap()
        .identity_settings()
        .unwrap()
    };
    assert!(crate::worker_identity::storage_identity(&settings(&config)).is_ok());
    for key in ["stateRoot", "scratchRoot"] {
        let original = config[key].clone();
        config[key] = json!(format!("{}//./", original.as_str().unwrap()));
        assert!(crate::worker_identity::storage_identity(&settings(&config)).is_err());
        config[key] = original;
    }
    assert!(paths.home().exists());
}
