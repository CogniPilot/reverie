//! Root inside an owned user namespace, never host administrator escalation.
use super::*;
use std::{
    os::unix::fs::{MetadataExt, PermissionsExt},
    process::Command,
};

fn generations(root: &Path) -> BTreeMap<String, (u32, u32, u32, i64, i64)> {
    ["", "-journal", "-wal", "-shm"]
        .into_iter()
        .filter_map(|suffix| {
            let metadata = fs::metadata(root.join(format!("memory.sqlite{suffix}"))).ok()?;
            Some((
                suffix.to_owned(),
                (
                    metadata.uid(),
                    metadata.gid(),
                    metadata.mode(),
                    metadata.ctime(),
                    metadata.ctime_nsec(),
                ),
            ))
        })
        .collect()
}
fn changed(error: &MemoryError) -> bool {
    match error {
        MemoryError::ReadinessChanged => true,
        MemoryError::Finalization { primary, secondary } => changed(primary) || changed(secondary),
        _ => false,
    }
}
pub(super) fn observe(root: &Path) {
    let status = fs::read_to_string("/proc/self/status").unwrap();
    let uid = status
        .lines()
        .find_map(|line| line.strip_prefix("Uid:"))
        .unwrap()
        .split_whitespace()
        .nth(1)
        .unwrap();
    assert_eq!(
        uid, "0",
        "must measure actual root semantics, not an environment claim"
    );
    let before = bytes(root);
    let before_metadata = generations(root);
    let setid = fs::metadata(root.join("memory.sqlite-shm")).unwrap().mode() & 0o2000 != 0;
    let disposition = match MemoryStartupStore::open(root.join("memory.sqlite")) {
        Err(error) => {
            assert!(
                setid && matches!(error, MemoryError::ReadinessRecoveryRequired),
                "{error:?}"
            );
            format!("{error:?}")
        }
        Ok(mut owner) => {
            assert!(!setid, "set-ID sidecar must refuse before any SQLite open");
            let error = owner.preflight().unwrap_err();
            let after_metadata = generations(root);
            if before_metadata != after_metadata {
                assert!(
                    changed(&error),
                    "root metadata drift must not disappear behind collision: {error:?}"
                );
            }
            assert!(!matches!(owner.shutdown(), ShutdownStatus::Pending(_)));
            format!("{error:?}")
        }
    };
    assert_eq!(
        before,
        bytes(root),
        "root refusal must preserve all raw DB/sidecar/profile/config bytes"
    );
    let after_metadata = generations(root);
    if setid {
        assert_eq!(
            before_metadata, after_metadata,
            "pre-open set-ID refusal must not fchown"
        );
    }
    fs::write(root.join("root-observation.json"),serde_json::to_vec_pretty(&serde_json::json!({
        "euid":0,"setid":setid,"disposition":disposition,"allRawBytesUnchanged":true,
        "metadataUnchanged":before_metadata==after_metadata,
        "scope":"matching-owner root may change sidecar ctime; no blanket root metadata-inert migration claim"
    })).unwrap()).unwrap();
}
#[test]
fn actual_namespace_root_refuses_setid_before_open_and_exposes_matching_owner_drift() {
    for setid in [false, true] {
        let tree = Tree::new();
        super::seeded(&tree);
        super::killed(&tree, "readiness-wal");
        if setid {
            let file = tree.0.join("memory.sqlite-shm");
            let mode = fs::metadata(&file).unwrap().permissions().mode();
            fs::set_permissions(file, fs::Permissions::from_mode(mode | 0o2000)).unwrap();
        }
        let output = Command::new("unshare")
            .args(["--user", "--map-root-user", "--"])
            .arg(std::env::current_exe().unwrap())
            .args([
                "--ignored",
                "--exact",
                "memory_process_child",
                "--nocapture",
                "--test-threads=1",
            ])
            .env("REVERIE_TEST_MEMORY_ROOT", &tree.0)
            .env("REVERIE_TEST_MEMORY_MODE", "readiness-root-control")
            .env("REVERIE_TEST_MEMORY_INDEX", "0")
            .output()
            .unwrap();
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(
            output.status.success(),
            "{stdout}{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(
            stdout.contains("1 passed; 0 failed")
                && stdout.contains("test memory_process_child ..."),
            "{stdout}"
        );
        let report: serde_json::Value =
            serde_json::from_slice(&fs::read(tree.0.join("root-observation.json")).unwrap())
                .unwrap();
        assert_eq!(report["euid"], 0);
        assert_eq!(report["allRawBytesUnchanged"], true);
        eprintln!("actual owned user-namespace root control: {report}");
    }
}
