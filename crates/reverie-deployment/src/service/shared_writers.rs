//! Early refusal of observed shared writers; the snapshot still verifies bytes.
use super::*;
use std::collections::BTreeSet;

impl DeploymentService {
    /// Refuse observed other-container writers before interrupting the website.
    /// This is not a writer-exclusion certificate: external processes and later
    /// changes remain subject to the snapshot's original consistency checks.
    pub(super) fn refuse_shared_writers(&self, source: &Value) -> Result<()> {
        let console = data_source_value(source)?.join("console").canonicalize()?;
        let selected = model::cid(model::string(source, "Id")?)?;
        let inventory = self.engine.json("GET", "/containers/json", None)?;
        refuse_overlaps(&inventory, selected, &console)
    }
}

fn refuse_overlaps(inventory: &Value, selected: &str, console: &Path) -> Result<()> {
    let rows = inventory
        .as_array()
        .ok_or_else(|| DeploymentError::new("DEPLOYMENT_WRITER_INVENTORY_UNCONFIRMED"))?;
    let mut identities = BTreeSet::new();
    for row in rows {
        let id = model::cid(model::string(row, "Id")?)?;
        require(
            identities.insert(id),
            "DEPLOYMENT_WRITER_INVENTORY_UNCONFIRMED",
        )?;
        require(
            matches!(
                row["State"].as_str(),
                Some("running" | "paused" | "restarting")
            ),
            "DEPLOYMENT_WRITER_INVENTORY_UNCONFIRMED",
        )?;
        if id == selected {
            continue;
        }
        let mounts = row["Mounts"]
            .as_array()
            .ok_or_else(|| DeploymentError::new("DEPLOYMENT_WRITER_INVENTORY_UNCONFIRMED"))?;
        for mount in mounts {
            refuse_mount(mount, console)?;
        }
    }
    require(
        identities.contains(selected),
        "DEPLOYMENT_WRITER_INVENTORY_UNCONFIRMED",
    )
}

fn refuse_mount(mount: &Value, console: &Path) -> Result<()> {
    let writable = mount["RW"]
        .as_bool()
        .ok_or_else(|| DeploymentError::new("DEPLOYMENT_WRITER_INVENTORY_UNCONFIRMED"))?;
    if !writable || mount["Type"] == "tmpfs" {
        return Ok(());
    }
    require(
        matches!(mount["Type"].as_str(), Some("bind" | "volume")),
        "DEPLOYMENT_WRITER_INVENTORY_UNCONFIRMED",
    )?;
    let source = Path::new(model::string(mount, "Source")?);
    require(
        source.is_absolute(),
        "DEPLOYMENT_WRITER_INVENTORY_UNCONFIRMED",
    )?;
    let source = source.canonicalize()?;
    require(
        !(source.starts_with(console) || console.starts_with(&source)),
        "DEPLOYMENT_SHARED_WRITABLE_MOUNT",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, os::unix::fs::symlink};

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir()
                .join(format!("deployment-shared-writers-{}", new_id().unwrap()));
            fs::create_dir(&root).unwrap();
            fs::create_dir_all(root.join("console/accounts/profile")).unwrap();
            fs::create_dir(root.join("unrelated")).unwrap();
            symlink(root.join("console/accounts/profile"), root.join("alias")).unwrap();
            Self(root)
        }
        fn console(&self) -> PathBuf {
            self.0.join("console")
        }
        fn container(&self, id: char, source: &Path, writable: bool) -> Value {
            json!({"Id":id.to_string().repeat(64),"State":"running",
                "Mounts":[{"Type":"bind","Source":source,"RW":writable}]})
        }
        fn check(&self, rows: Value) -> Result<()> {
            let mut inventory = vec![self.container('a', &self.console(), true)];
            inventory.extend(rows.as_array().unwrap().iter().cloned());
            refuse_overlaps(&Value::Array(inventory), &"a".repeat(64), &self.console())
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    #[test]
    fn live_account_writer_refuses_before_a_stopped_console_snapshot() {
        let fixture = Fixture::new();
        let rows =
            json!([fixture.container('b', &fixture.console().join("accounts/profile"), true)]);
        assert_eq!(
            fixture.check(rows).unwrap_err().code(),
            "DEPLOYMENT_SHARED_WRITABLE_MOUNT"
        );
    }

    #[test]
    fn aliases_and_ancestor_mounts_are_writers_too() {
        let fixture = Fixture::new();
        for source in [&fixture.0, &fixture.console(), &fixture.0.join("alias")] {
            assert_eq!(
                fixture
                    .check(json!([fixture.container('b', source, true)]))
                    .unwrap_err()
                    .code(),
                "DEPLOYMENT_SHARED_WRITABLE_MOUNT"
            );
        }
    }

    #[test]
    fn selected_readonly_private_tmpfs_and_disjoint_mounts_do_not_block() {
        let fixture = Fixture::new();
        fixture
            .check(json!([
                fixture.container('b', &fixture.console(), false),
                fixture.container('c', &fixture.0.join("unrelated"), true),
                {"Id":"d".repeat(64),"State":"running","Mounts":[{"Type":"tmpfs","RW":true}]}
            ]))
            .unwrap();
    }

    #[test]
    fn missing_or_ambiguous_inventory_never_implies_no_shared_writers() {
        let fixture = Fixture::new();
        for inventory in [Value::Null, json!([]), json!([{"Id":"invalid"}])] {
            assert!(refuse_overlaps(&inventory, &"a".repeat(64), &fixture.console()).is_err());
        }
        let selected = fixture.container('a', &fixture.console(), true);
        assert!(fixture.check(json!([selected])).is_err());
        let mut invalid = fixture.container('b', &fixture.0.join("unrelated"), true);
        invalid["Mounts"][0]["RW"] = Value::Null;
        assert!(fixture.check(json!([invalid])).is_err());
    }
}
