//! Real same-App sequence with an owned target. Engine replies and memory/
//! cgroup facts remain controlled; this is not a live Docker qualification.
use super::*;
use reverie_contracts::kernel_accounting;
use std::{
    path::PathBuf,
    process::{Command, Stdio},
    thread::JoinHandle,
};

struct Target {
    root: PathBuf,
    reaper: Option<JoinHandle<()>>,
}
impl Target {
    fn new(owned: &mut Owned) -> Self {
        // No employee lease exists yet. The exact target cannot inherit it.
        let root = owned.setup.tree.root.clone();
        let mut child = Command::new(crate::installing_broker::recovered::tests::program())
            .arg("source-stop-target")
            .current_dir(&root)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let pid = child.id();
        let directory = root.clone();
        let reaper = std::thread::spawn(move || {
            let result = child.wait().unwrap();
            fs::write(
                directory.join("source-target.reaped"),
                "exact target reaped",
            )
            .unwrap();
            assert!(result.success());
        });
        let target = Self {
            root,
            reaper: Some(reaper),
        };
        let end = Instant::now() + Duration::from_secs(5);
        while !target.root.join("source-target.ready").exists() && Instant::now() < end {
            std::thread::sleep(Duration::from_millis(2));
        }
        assert!(target.root.join("source-target.ready").exists());
        let start = kernel_accounting::process_start(
            &fs::read_to_string(format!("/proc/{pid}/stat")).unwrap(),
        )
        .unwrap();
        owned.setup.rows[1]["State"]["Pid"] = json!(pid);
        let cid = owned.setup.rows[1]["Id"].as_str().unwrap();
        owned.fixture.process_start(cid, &start);
        owned.setup.tree.write("source-stop.cid", cid.as_bytes());
        target.write_observations(owned);
        target
    }
    fn write_observations(&self, owned: &Owned) {
        let rows = &owned.setup.rows;
        owned.setup.tree.write(
            "inventory.out",
            rows.iter()
                .map(Value::to_string)
                .collect::<Vec<_>>()
                .join("\n")
                .as_bytes(),
        );
        owned
            .setup
            .tree
            .write("writers.out", &serde_json::to_vec(rows).unwrap());
        owned.setup.tree.write(
            "source-inspect.out",
            &serde_json::to_vec(&json!([rows[1]])).unwrap(),
        );
        let mut stopped = rows.clone();
        stopped[1]["State"] = json!({"Running":false,"Pid":0});
        owned.setup.tree.write(
            "stopped-inventory.out",
            stopped
                .iter()
                .map(Value::to_string)
                .collect::<Vec<_>>()
                .join("\n")
                .as_bytes(),
        );
        owned.setup.tree.write(
            "stopped-source-inspect.out",
            &serde_json::to_vec(&json!([stopped[1]])).unwrap(),
        );
    }
}
impl Drop for Target {
    fn drop(&mut self) {
        fs::write(
            self.root.join("source-target.release"),
            "test teardown only",
        )
        .unwrap();
        if let Some(reaper) = self.reaper.take() {
            reaper.join().unwrap();
        }
    }
}

#[test]
fn actual_protected_source_sequence_reaps_owned_target_then_closes_phone_and_original_lease() {
    crate::test_process::owning_case!(
        actual_protected_source_sequence_reaps_owned_target_then_closes_phone_and_original_lease
    );
    let mut owned = Owned::new();
    let _target = Target::new(&mut owned);
    let mut claim = prepared(&owned);
    let intent = claim.begin_native_start().unwrap();
    owned.fixture.old_release("released");
    owned.assert_held();
    let facts = claim.stop_original_source(&intent).unwrap();
    assert!(owned.setup.tree.root.join("source-target.reaped").exists());
    assert_eq!(facts.state(), "SOURCE_RELEASED_TARGET_NOT_CREATED");
    let mut source = owned.setup.rows[1].clone();
    source["State"] = json!({"Running":false,"Pid":0});
    assert_eq!(
        fs::read(owned.setup.tree.root.join("source-inspect.out")).unwrap(),
        serde_json::to_vec(&json!([source])).unwrap()
    );
    let config = owned.broker.configuration().unwrap();
    let lease =
        StorageLease::acquire_migration(config.configuration(), intent.target_session()).unwrap();
    assert_eq!(lease.paths().key(), claim.source_paths().key());
    lease.close().unwrap();
    let calls = fs::read_to_string(owned.setup.tree.root.join("calls.txt")).unwrap();
    let stop = format!(
        "stop\0--time\02\0{}",
        owned.setup.rows[1]["Id"].as_str().unwrap()
    );
    assert_eq!(calls.lines().filter(|line| *line == stop).count(), 1);
    assert!(!calls.lines().any(|line| line.starts_with("kill\0")));
    assert!(facts.capacity_retained() && !facts.verified() && !facts.retry_allowed());
    owned.assert_admission_free();
    assert_eq!(
        claim.stop_original_source(&intent).err().unwrap().code(),
        "RESOURCE_NATIVE_SOURCE_STOP_ALREADY_ATTEMPTED"
    );
    claim.close().unwrap();
}
