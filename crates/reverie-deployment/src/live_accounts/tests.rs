use super::*;
use std::{
    fs,
    os::unix::fs::{DirBuilderExt, symlink},
};
// These unit projections are DATA only. The actual Inventory capture additionally
// requires the separate real proc-root/Engine joins exercised by service tests.
fn writer(row: &Value, observed: &Value, console: &Path) -> Result<Writer> {
    super::writer(
        row,
        observed,
        console,
        "123".into(),
        MountObservation::NamespaceFd {
            namespace: "mnt:[123]".into(),
        },
    )
}

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let mut nonce = [0_u8; 16];
        getrandom::getrandom(&mut nonce).unwrap();
        let suffix = nonce.iter().map(|b| format!("{b:02x}")).collect::<String>();
        let root = std::env::temp_dir().join(format!("deployment-live-{suffix}"));
        fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
        fs::create_dir_all(root.join("console/accounts/profile")).unwrap();
        fs::create_dir(root.join("console/metadata")).unwrap();
        symlink(root.join("console/accounts/profile"), root.join("alias")).unwrap();
        Self(root)
    }
    fn console(&self) -> PathBuf {
        self.0.join("console")
    }
    fn row(&self) -> Value {
        serde_json::json!({"Id":"d".repeat(64),"ImageID":format!("sha256:{}", "e".repeat(64)),"State":"running",
            "Mounts":[{"Type":"bind","Source":self.console().join("accounts/profile"),"Destination":"/account","RW":true}]})
    }
    fn observed(&self) -> Value {
        let row = self.row();
        serde_json::json!({"Id":row["Id"],"Image":row["ImageID"],"Config":{"Cmd":["existing-provider"]},"HostConfig":{},"Mounts":row["Mounts"],
            "State":{"Running":true,"Paused":false,"Restarting":false,"Dead":false,"Pid":42,"StartedAt":"original"}})
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn approved_account_directory_content_can_change_without_minting_a_verified_backup() {
    let f = Fixture::new();
    let before = writer(&f.row(), &f.observed(), &f.console()).unwrap();
    fs::write(f.console().join("accounts/profile/token"), "changed-live").unwrap();
    let after = writer(&f.row(), &f.observed(), &f.console()).unwrap();
    assert_eq!(before, after);
    let inventory = Inventory {
        version: 1,
        console: f.console(),
        writers: vec![before],
    };
    inventory.validate(&f.console()).unwrap();
    let preview = inventory.preview();
    assert_eq!(preview.backup_consistency, "unverified-live-copy");
    assert!(!preview.code_rollback_guaranteed && !preview.automatic_data_restore);
    assert_eq!(preview.writers[0].container_id, "d".repeat(64));
    assert!(
        !serde_json::to_string(&preview)
            .unwrap()
            .contains("existing-provider")
    );
}

#[test]
fn console_ancestors_metadata_aliases_files_and_nested_paths_never_enter_the_disposition() {
    let f = Fixture::new();
    let file = f.console().join("accounts/file");
    fs::write(&file, "data").unwrap();
    let nested = f.console().join("accounts/profile/nested");
    fs::create_dir(&nested).unwrap();
    for source in [
        f.0.clone(),
        f.console(),
        f.console().join("accounts"),
        f.console().join("metadata"),
        f.0.join("alias"),
        file,
        nested,
    ] {
        let mut row = f.row();
        row["Mounts"][0]["Source"] = serde_json::json!(source);
        assert!(accounts(&row, &f.console()).is_err(), "{source:?}");
    }
}

#[test]
fn immutable_image_incarnation_state_and_full_mount_projection_are_bound() {
    let f = Fixture::new();
    let baseline = writer(&f.row(), &f.observed(), &f.console()).unwrap();
    for key in ["Id", "Image"] {
        let mut observed = f.observed();
        observed[key] = serde_json::json!("foreign");
        assert!(writer(&f.row(), &observed, &f.console()).is_err());
    }
    for key in ["Paused", "Restarting", "Dead"] {
        let mut observed = f.observed();
        observed["State"][key] = serde_json::json!(true);
        assert!(writer(&f.row(), &observed, &f.console()).is_err());
    }
    let mut changed = f.observed();
    changed["State"]["Pid"] = serde_json::json!(43);
    assert_ne!(writer(&f.row(), &changed, &f.console()).unwrap(), baseline);
    changed = f.observed();
    changed["State"]["StartedAt"] = serde_json::json!("later");
    assert_ne!(writer(&f.row(), &changed, &f.console()).unwrap(), baseline);
    changed = f.observed();
    changed["Config"]["Cmd"] = serde_json::json!(["foreign"]);
    assert_ne!(writer(&f.row(), &changed, &f.console()).unwrap(), baseline);
    changed = f.observed();
    changed["Mounts"][0]["RW"] = serde_json::json!(false);
    assert!(writer(&f.row(), &changed, &f.console()).is_err());
}

#[test]
fn replaced_account_directory_and_unconfirmed_inventory_refuse() {
    let f = Fixture::new();
    let before = writer(&f.row(), &f.observed(), &f.console()).unwrap();
    fs::rename(
        f.console().join("accounts/profile"),
        f.console().join("accounts/old"),
    )
    .unwrap();
    fs::create_dir(f.console().join("accounts/profile")).unwrap();
    assert_ne!(
        writer(&f.row(), &f.observed(), &f.console()).unwrap(),
        before
    );
    assert!(rows(&Value::Null).is_err());
    assert!(rows(&serde_json::json!([f.row(), f.row()])).is_err());
    let mut row = f.row();
    row["State"] = serde_json::json!("exited");
    assert!(rows(&serde_json::json!([row])).is_err());
}

#[test]
fn census_ignores_only_container_and_mount_enumeration_order() {
    let f = Fixture::new();
    let mut first = f.row();
    first["Mounts"]
        .as_array_mut()
        .unwrap()
        .push(serde_json::json!({
            "Type":"bind", "Source":"/unrelated", "Destination":"/other", "RW":false
        }));
    let mut second = first.clone();
    second["Id"] = serde_json::json!("b".repeat(64));
    let baseline = census(&serde_json::json!([first, second])).unwrap();
    first["Mounts"].as_array_mut().unwrap().reverse();
    second["Mounts"].as_array_mut().unwrap().reverse();
    assert_eq!(
        baseline,
        census(&serde_json::json!([second, first])).unwrap()
    );
}

#[test]
fn census_preserves_every_mount_field_and_multiplicity() {
    let f = Fixture::new();
    let original = f.row();
    let baseline = census(&serde_json::json!([original])).unwrap();
    for (key, value) in [
        ("Source", serde_json::json!("/changed")),
        ("Destination", serde_json::json!("/changed")),
        ("RW", serde_json::json!(false)),
        ("Type", serde_json::json!("volume")),
        ("Propagation", serde_json::json!("rshared")),
    ] {
        let mut changed = original.clone();
        changed["Mounts"][0][key] = value;
        assert_ne!(
            baseline,
            census(&serde_json::json!([changed])).unwrap(),
            "{key}"
        );
    }
    let mut duplicate = original.clone();
    let mount = duplicate["Mounts"][0].clone();
    duplicate["Mounts"].as_array_mut().unwrap().push(mount);
    assert_ne!(baseline, census(&serde_json::json!([duplicate])).unwrap());
}

#[test]
fn census_refuses_missing_or_non_array_mounts() {
    let f = Fixture::new();
    for value in [
        Value::Null,
        serde_json::json!({}),
        serde_json::json!("unknown"),
    ] {
        let mut row = f.row();
        row["Mounts"] = value;
        assert!(census(&serde_json::json!([row])).is_err());
    }
}
