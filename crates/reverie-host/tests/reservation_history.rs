//! Actual original historical completed() with private owned files. No native
//! completion producer, effect, admission or launch permission is established.
use reverie_contracts::{
    operations_v1, reservation_engine::ReservationConfiguration,
    reservation_history::HistoricalCompletion, worker_config,
};
use reverie_core::operations::OperationState;
use reverie_host::reservation_control;
use serde::Deserialize;
use std::{
    fs,
    os::unix::fs::{MetadataExt, PermissionsExt, symlink},
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Tree(PathBuf);
impl Tree {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "reverie-completed-history-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::create_dir(root.join("operations")).unwrap();
        for name in ["", "operations"] {
            fs::set_permissions(root.join(name), fs::Permissions::from_mode(0o700)).unwrap();
        }
        Self(root)
    }
    fn config(&self) -> ReservationConfiguration {
        ReservationConfiguration::capture(worker_config::decode(&serde_json::to_vec(&serde_json::json!({"uid":fs::metadata(&self.0).unwrap().uid(),"stateRoot":self.0.join("state"),"resourceReservations":{"directory":self.0}})).unwrap()).unwrap())
    }
    fn write(&self, name: &str, raw: &str) {
        let path = self.0.join("operations").join(name);
        fs::write(&path, raw).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
    }
}
impl Drop for Tree {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}
#[derive(Deserialize)]
struct PendingCorpus {
    cases: Vec<PendingCase>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PendingCase {
    name: String,
    document: String,
    filename: String,
    metadata: String,
    error: Option<String>,
    error_type: Option<String>,
}
fn observe_pending(
    config: &ReservationConfiguration,
    document: &reverie_core::operations::OperationDocument,
) -> Result<(), String> {
    for (index, name) in reservation_control::settlement_names(config)
        .map_err(|e| e.code().to_owned())?
        .iter()
        .enumerate()
    {
        reverie_contracts::reservation_history::validate_pending_position(index)
            .map_err(|e| e.code().to_owned())?;
        if let Some(id) = reverie_contracts::reservation_history::pending_operation_id(name)
            .map_err(|e| e.code().to_owned())?
        {
            let data = reservation_control::read_settlement_pending(config, &id)
                .map_err(|e| e.code().to_owned())?;
            reverie_contracts::reservation_history::validate_pending(&id, &data, document)
                .map_err(|e| e.code().to_owned())?;
        }
    }
    Ok(())
}
#[test]
fn actual_python_pending_canonical_id_closed_shape_phase_and_orphan_rules_match() {
    let corpus: PendingCorpus =
        serde_json::from_str(include_str!("fixtures/reservation-pending-python.json")).unwrap();
    assert_eq!(corpus.cases.len(), 14);
    for case in corpus.cases {
        let tree = Tree::new();
        let config = tree.config();
        tree.write(&case.filename, &case.metadata);
        let document = operations_v1::decode(case.document.as_bytes()).unwrap();
        let result = observe_pending(&config, &document);
        assert!(
            case.error_type.is_none()
                || matches!(
                    case.error_type.as_deref(),
                    Some("Refused" | "OperationRefusal")
                )
        );
        assert_eq!(result.err(), case.error, "{}", case.name);
    }
}
#[test]
fn native_directory_name_data_preserves_bytes_and_does_not_sort_or_grant_custody() {
    use std::{ffi::OsStr, os::unix::ffi::OsStrExt};
    let tree = Tree::new();
    let config = tree.config();
    for name in [
        b"z-last".as_slice(),
        b"invalid-\xff",
        b"first\nline",
        b"a-first",
    ] {
        fs::write(
            tree.0.join("operations").join(OsStr::from_bytes(name)),
            b"{}",
        )
        .unwrap();
    }
    let expected = fs::read_dir(tree.0.join("operations"))
        .unwrap()
        .map(|entry| reverie_core::posix_text::decode(entry.unwrap().file_name().as_bytes()))
        .collect::<Vec<_>>();
    assert_eq!(
        reservation_control::settlement_names(&config).unwrap(),
        expected
    );
    let alias = tree.0.join("operations-alias");
    symlink("operations", &alias).unwrap();
    assert_eq!(
        reverie_store::operations::settlement_directory_names(&alias)
            .unwrap()
            .iter()
            .map(|bytes| reverie_core::posix_text::decode(bytes))
            .collect::<Vec<_>>(),
        expected,
        "Path.iterdir follows its directory; these names are not custody proof"
    );
}

#[test]
fn native_directory_failure_retains_its_typed_ledger_cause_without_downcasting() {
    use std::error::Error;
    let tree = Tree::new();
    let config = tree.config();
    fs::remove_dir(tree.0.join("operations")).unwrap();
    fs::write(tree.0.join("operations"), b"not a directory").unwrap();
    let error = reservation_control::settlement_names(&config).unwrap_err();
    assert_eq!(error.code(), "LEDGER_UNAVAILABLE");
    assert!(error.source().is_some());
    let reservation_control::ControlHostError::Journal(
        reverie_store::operations::JournalError::Filesystem(reverie_store::StoreError::Io {
            source,
            ..
        }),
    ) = error
    else {
        panic!("real native failure must retain its typed ledger/finalizer vocabulary")
    };
    assert_eq!(source.raw_os_error(), Some(libc::ENOTDIR));
}
#[derive(Deserialize)]
struct Corpus {
    cases: Vec<Case>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    name: String,
    document: String,
    receipt: Option<String>,
    verified: Option<String>,
    pending: bool,
    completed: Option<bool>,
    error: Option<String>,
    error_type: Option<String>,
}
#[test]
fn all_actual_python_historical_receipt_and_file_phase_cases_match() {
    let corpus: Corpus =
        serde_json::from_str(include_str!("fixtures/reservation-history-python.json")).unwrap();
    assert_eq!(corpus.cases.len(), 33);
    for case in corpus.cases {
        let tree = Tree::new();
        let config = tree.config();
        let document = operations_v1::decode(case.document.as_bytes()).unwrap();
        let operation = document.operations().values().next().unwrap();
        let id = &operation.data().id;
        if let Some(raw) = case.receipt {
            tree.write(&format!("settled-{}.json", id.as_str()), &raw);
        }
        if let Some(raw) = case.verified {
            tree.write(&format!("verified-{}.json", id.as_str()), &raw);
        }
        if case.pending {
            symlink(
                "absent",
                tree.0
                    .join("operations")
                    .join(format!("settlement-{}.pending.json", id.as_str())),
            )
            .unwrap();
        }
        let mut reads = Vec::new();
        let result = (|| -> Result<bool, String> {
            if operation.data().state != OperationState::Completed {
                return Ok(false);
            }
            reads.push("settled");
            let receipt = reservation_control::read_completion_receipt(&config, id)
                .map_err(|e| e.code().to_owned())?;
            let history = HistoricalCompletion::capture(operation, &receipt)
                .map_err(|e| e.code().to_owned())?;
            reads.push("verified");
            let verified = reservation_control::read_verification_receipt(&config, id)
                .map_err(|e| e.code().to_owned())?;
            history
                .assert_verified_and_plan(&verified)
                .map_err(|e| e.code().to_owned())?;
            Ok(
                !reservation_control::settlement_pending_present(&config, id)
                    .map_err(|e| e.code().to_owned())?,
            )
        })();
        let expected = match case.error_type.as_deref() {
            None => Ok(case.completed.unwrap()),
            Some("FileNotFoundError") => Err("STORAGE_IDENTITY_IO".into()),
            Some("Refused" | "Refusal" | "OperationRefusal") => Err(case.error.unwrap()),
            other => panic!("unclassified actual Python {other:?}: {}", case.name),
        };
        assert_eq!(result, expected, "{}", case.name);
        if case.name == "verified-digest-not-a-string-before-missing-file" {
            assert_eq!(reads, ["settled", "verified"]);
        }
        if case.name == "noncompleted-does-not-read-any-receipt" {
            assert!(reads.is_empty());
        }
    }
}
