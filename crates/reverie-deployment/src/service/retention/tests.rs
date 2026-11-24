//! Actual journals and directories in the isolated fixture. No Engine request
//! is needed or issued.
use super::*;
use crate::service::rollback::network_tests::fixture::Fixture;

fn namespace(test: &str, scenario: fn()) {
    crate::test_namespace::run(&format!("service::retention::tests::{test}"), scenario);
}
/// Another prepared operation of the same installation.
fn older(f: &Fixture, letter: char) -> Operation {
    let mut plan: Plan =
        serde_json::from_value(serde_json::to_value(&f.operation.plan).unwrap()).unwrap();
    plan.operation = letter.to_string().repeat(32);
    let operation = Operation::create(&f.service.installation.state, plan).unwrap();
    let candidate = "b".repeat(64);
    operation
        .record("candidate", &json!({"id":candidate}))
        .unwrap();
    operation
        .record(
            "prepared",
            &json!({"candidateId":candidate,"validated":true}),
        )
        .unwrap();
    operation
}
fn ready(operation: &Operation) {
    operation
        .record(
            "ready",
            &json!({"containerId":"b".repeat(64),"mode":"hybrid-rust-front","brokerChanged":false}),
        )
        .unwrap();
}
fn restored(operation: &Operation) {
    operation.attempt("stop-attempt").unwrap();
    operation.attempt("rollback-attempt").unwrap();
    operation
        .record(
            "restored",
            &json!({"containerId":"a".repeat(64),"dataRestored":false,"brokerChanged":false}),
        )
        .unwrap();
}
/// `newer` took over the claim that `older` held.
fn handover(older: &Operation, newer: &Operation) {
    let link = json!({"successor":newer.plan.operation,"claimDigest":"d".repeat(64)});
    older.record("successor-attempt", &link).unwrap();
    older.record("superseded", &link).unwrap();
    newer
        .record(
            "claim-acquired",
            &json!({"operation":newer.plan.operation,"predecessor":older.plan.operation}),
        )
        .unwrap();
}
fn archive(operation: &Operation) -> PathBuf {
    let directory = operation.directory.join("snapshot");
    fs::create_dir(&directory).unwrap();
    fs::write(directory.join("console.tar"), vec![7; 64 * 1024]).unwrap();
    directory
}
fn private_directory(path: &str) -> PathBuf {
    fs::create_dir(path).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
    PathBuf::from(path)
}
/// A journaled rehearsal directory holding an extracted copy with a
/// directory its owner cannot write.
fn rehearsal(operation: &Operation, root: &Path) -> PathBuf {
    let info = fs::metadata(root).unwrap();
    operation
        .record_rehearsal_root(root, (info.dev(), info.ino()))
        .unwrap();
    let copy = root.join("rehearsal");
    fs::create_dir_all(copy.join("console/read-only")).unwrap();
    fs::write(copy.join("console/read-only/file"), b"restored").unwrap();
    fs::set_permissions(
        copy.join("console/read-only"),
        fs::Permissions::from_mode(0o555),
    )
    .unwrap();
    copy
}
fn dispositions(report: &Value) -> Vec<(String, String)> {
    report["operations"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| {
            (
                row["operation"].as_str().unwrap()[..1].to_owned(),
                row["disposition"].as_str().unwrap().to_owned(),
            )
        })
        .collect()
}
fn pairs(expected: &[(&str, &str)]) -> Vec<(String, String)> {
    expected
        .iter()
        .map(|(operation, disposition)| ((*operation).to_owned(), (*disposition).to_owned()))
        .collect()
}
/// Active `c`, then `1` ready, `2` restored after a refused rehearsal, `3`
/// ready, and `4` whose update never closed. Each holds an archive.
struct History {
    f: Fixture,
    operations: Vec<Operation>,
    copy: PathBuf,
    root: PathBuf,
}
fn history() -> History {
    let f = Fixture::new();
    let operations = ['1', '2', '3', '4'].map(|letter| older(&f, letter));
    handover(&operations[0], &f.operation);
    for pair in operations.windows(2) {
        handover(&pair[1], &pair[0]);
    }
    ready(&operations[0]);
    restored(&operations[1]);
    ready(&operations[2]);
    operations[3].attempt("stop-attempt").unwrap();
    archive(&f.operation);
    for operation in &operations {
        archive(operation);
    }
    let root = private_directory("/tmp/rehearsal-two");
    let copy = rehearsal(&operations[1], &root);
    History {
        f,
        operations: operations.into(),
        copy,
        root,
    }
}

#[test]
fn the_report_keeps_the_recent_and_the_unclosed_and_removes_nothing() {
    namespace(
        "the_report_keeps_the_recent_and_the_unclosed_and_removes_nothing",
        || {
            let h = history();
            let report = h.f.service.prune_deployments(false, 2).unwrap();
            assert_eq!(
                dispositions(&report),
                pairs(&[
                    ("c", "active"),
                    ("1", "kept-recent"),
                    ("2", "prunable"),
                    ("3", "prunable"),
                    ("4", "not-closed"),
                ])
            );
            assert_eq!(report["success"], true);
            assert_eq!(report["applied"], false);
            assert_eq!(report["removedBytes"], 0);
            assert!(report["prunableBytes"].as_u64().unwrap() >= 2 * 64 * 1024);
            assert!(report["historyEndedBy"].is_null());
            let kinds = report["operations"][2]["artifacts"]
                .as_array()
                .unwrap()
                .iter()
                .map(|artifact| artifact["kind"].as_str().unwrap())
                .collect::<Vec<_>>();
            assert_eq!(kinds, ["backup", "rehearsal"]);
            for operation in h.operations.iter().chain([&h.f.operation]) {
                assert!(operation.directory.join("snapshot/console.tar").is_file());
                assert!(!operation.exists("artifacts-prune-attempt"));
            }
            assert!(h.copy.join("console/read-only/file").is_file());
            assert!(h.f.port.calls().is_empty());
            h.f.close();
        },
    );
}

#[test]
fn apply_removes_only_the_journaled_storage_of_closed_superseded_operations() {
    namespace(
        "apply_removes_only_the_journaled_storage_of_closed_superseded_operations",
        || {
            let h = history();
            fs::write(h.root.join("owner-notes"), b"not placed by the tool").unwrap();
            let report = h.f.service.prune_deployments(true, 2).unwrap();
            assert_eq!(report["success"], true);
            assert_eq!(report["removedBytes"], report["prunableBytes"]);
            assert!(report["removedBytes"].as_u64().unwrap() >= 2 * 64 * 1024);
            for (index, removed) in [(0, false), (1, true), (2, true), (3, false)] {
                let operation = &h.operations[index];
                assert_eq!(
                    !operation.directory.join("snapshot").exists(),
                    removed,
                    "{index}"
                );
                assert_eq!(operation.exists("artifacts-pruned"), removed, "{index}");
                // The journal itself is never removed.
                assert!(operation.directory.join("plan.json").is_file());
            }
            assert!(
                h.f.operation
                    .directory
                    .join("snapshot/console.tar")
                    .is_file()
            );
            assert!(!h.copy.exists());
            assert!(h.root.is_dir());
            assert_eq!(
                fs::read(h.root.join("owner-notes")).unwrap(),
                b"not placed by the tool"
            );
            assert_eq!(h.operations[1].status().unwrap().stage, "SUPERSEDED");
            let again = h.f.service.prune_deployments(true, 2).unwrap();
            assert_eq!(
                dispositions(&again),
                pairs(&[("c", "active"), ("1", "kept-recent"), ("4", "not-closed")])
            );
            assert_eq!(again["prunableBytes"], 0);
            assert!(h.f.port.calls().is_empty());
            h.f.close();
        },
    );
}

#[test]
fn the_active_operation_is_kept_whatever_the_count() {
    namespace("the_active_operation_is_kept_whatever_the_count", || {
        let h = history();
        let none = h.f.service.prune_deployments(true, 0).unwrap();
        assert_eq!(
            dispositions(&none),
            pairs(&[
                ("c", "active"),
                ("1", "prunable"),
                ("2", "prunable"),
                ("3", "prunable"),
                ("4", "not-closed"),
            ])
        );
        assert!(
            h.f.operation
                .directory
                .join("snapshot/console.tar")
                .is_file()
        );
        assert!(
            h.operations[3]
                .directory
                .join("snapshot/console.tar")
                .is_file()
        );
        assert!(!h.operations[0].directory.join("snapshot").exists());
        h.f.close();
    });
}

#[test]
fn a_generous_count_keeps_everything() {
    namespace("a_generous_count_keeps_everything", || {
        let h = history();
        let report = h.f.service.prune_deployments(true, 9).unwrap();
        assert_eq!(report["prunableBytes"], 0);
        assert_eq!(report["removedBytes"], 0);
        for operation in &h.operations {
            assert!(operation.directory.join("snapshot/console.tar").is_file());
        }
        assert!(h.copy.exists());
        h.f.close();
    });
}

#[test]
fn a_rehearsal_directory_used_again_belongs_to_the_newer_operation() {
    namespace(
        "a_rehearsal_directory_used_again_belongs_to_the_newer_operation",
        || {
            let h = history();
            // The owner emptied the directory and the next update used it.
            fs::set_permissions(
                h.copy.join("console/read-only"),
                fs::Permissions::from_mode(0o755),
            )
            .unwrap();
            fs::remove_dir_all(&h.copy).unwrap();
            let newer = rehearsal(&h.operations[0], &h.root);
            let report = h.f.service.prune_deployments(true, 2).unwrap();
            assert_eq!(report["success"], true);
            assert!(!h.operations[1].directory.join("snapshot").exists());
            assert!(newer.join("console/read-only/file").is_file());
            h.f.close();
        },
    );
}

#[test]
fn a_replaced_rehearsal_directory_or_a_link_under_a_tool_name_is_left_alone() {
    namespace(
        "a_replaced_rehearsal_directory_or_a_link_under_a_tool_name_is_left_alone",
        || {
            let h = history();
            // Another directory now answers to the journaled path.
            fs::rename(&h.root, "/tmp/moved-away").unwrap();
            private_directory("/tmp/rehearsal-two");
            fs::create_dir("/tmp/rehearsal-two/rehearsal").unwrap();
            // A link where the third operation's archive directory was.
            let outside = private_directory("/tmp/outside");
            fs::write(outside.join("keep"), b"outside").unwrap();
            let third = h.operations[2].directory.join("snapshot");
            fs::remove_dir_all(&third).unwrap();
            std::os::unix::fs::symlink(&outside, &third).unwrap();
            let report = h.f.service.prune_deployments(true, 2).unwrap();
            assert!(Path::new("/tmp/rehearsal-two/rehearsal").is_dir());
            assert!(Path::new("/tmp/moved-away/rehearsal/console/read-only/file").is_file());
            assert_eq!(fs::read(outside.join("keep")).unwrap(), b"outside");
            assert!(third.is_symlink());
            let row = &report["operations"][3];
            assert_eq!(row["disposition"], "unconfirmed");
            assert_eq!(row["code"], NOT_A_DIRECTORY);
            // The second operation's own archive was still removed.
            assert!(!h.operations[1].directory.join("snapshot").exists());
            h.f.close();
        },
    );
}

#[test]
fn history_ends_at_an_operation_that_cannot_be_read() {
    namespace("history_ends_at_an_operation_that_cannot_be_read", || {
        let h = history();
        fs::remove_file(h.operations[1].directory.join("plan.json")).unwrap();
        let report = h.f.service.prune_deployments(true, 1).unwrap();
        assert_eq!(
            dispositions(&report),
            pairs(&[("c", "active"), ("1", "prunable")])
        );
        assert!(report["historyEndedBy"].is_string());
        for index in [1, 2, 3] {
            assert!(
                h.operations[index]
                    .directory
                    .join("snapshot/console.tar")
                    .is_file(),
                "{index}"
            );
        }
        assert!(h.copy.exists());
        h.f.close();
    });
}

#[test]
fn without_a_claim_there_is_no_history_to_prune() {
    namespace("without_a_claim_there_is_no_history_to_prune", || {
        let h = history();
        fs::remove_file(
            h.f.service
                .installation
                .state
                .join("console-deployment-active.json"),
        )
        .unwrap();
        let report = h.f.service.prune_deployments(true, 0).unwrap();
        assert!(report["operations"].as_array().unwrap().is_empty());
        assert!(
            h.operations[2]
                .directory
                .join("snapshot/console.tar")
                .is_file()
        );
        h.f.close();
    });
}

#[test]
fn the_rehearsal_directory_is_journaled_once_and_must_not_change() {
    namespace(
        "the_rehearsal_directory_is_journaled_once_and_must_not_change",
        || {
            let f = Fixture::new();
            assert!(f.operation.rehearsal_root().unwrap().is_none());
            let root = private_directory("/tmp/selected");
            let info = fs::metadata(&root).unwrap();
            let identity = (info.dev(), info.ino());
            f.operation.record_rehearsal_root(&root, identity).unwrap();
            f.operation.record_rehearsal_root(&root, identity).unwrap();
            let recorded = f.operation.rehearsal_root().unwrap().unwrap();
            assert_eq!((recorded.path, recorded.identity), (root, identity));
            let other = private_directory("/tmp/other");
            assert_eq!(
                f.operation
                    .record_rehearsal_root(&other, identity)
                    .unwrap_err()
                    .code(),
                "DEPLOYMENT_REHEARSAL_ROOT_CHANGED"
            );
            f.close();
        },
    );
}
