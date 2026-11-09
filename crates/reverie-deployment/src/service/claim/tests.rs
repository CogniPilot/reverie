use super::*;
use std::{
    fs,
    os::unix::fs::{DirBuilderExt, PermissionsExt},
    os::unix::net::UnixListener,
};
mod fixture;
use fixture::Fixture;

fn snapshot_refusal() -> DeploymentError {
    DeploymentError::snapshot(
        "DEPLOYMENT_SNAPSHOT_REFUSED",
        reverie_host::deployment_snapshot::SnapshotError::from(std::io::Error::other(
            "PRIVATE_STATUS_MESSAGE",
        )),
    )
}

#[test]
fn snapshot_refusal_status_recovers_safe_diagnostic_after_the_response_is_lost() {
    let mut fixture = Fixture::new(false);
    let initial = fixture
        .service
        .status(&fixture.next.plan.operation)
        .unwrap();
    assert!(initial.diagnostic.is_none());
    assert!(
        serde_json::to_value(initial)
            .unwrap()
            .get("diagnostic")
            .is_none()
    );
    fixture.next.attempt("stop-attempt").unwrap();
    drop(fixture.next.record_snapshot_refusal(snapshot_refusal()));
    let status = fixture
        .service
        .status(&fixture.next.plan.operation)
        .unwrap();
    let diagnostic = status.diagnostic.unwrap();
    fixture.close();
    assert_eq!(status.stage, "STOP_UNCONFIRMED");
    assert_eq!(diagnostic["error"]["code"], "DEPLOYMENT_SNAPSHOT_REFUSED");
    assert_eq!(diagnostic["error"]["snapshot"]["code"], "SNAPSHOT_IO");
    assert!(!diagnostic.to_string().contains("PRIVATE_"));
}

#[test]
fn snapshot_refusal_status_refuses_foreign_or_unsafe_persisted_diagnostics() {
    for kind in 0..6 {
        let mut fixture = Fixture::new(false);
        drop(fixture.next.record_snapshot_refusal(snapshot_refusal()));
        let path = fixture.next.directory.join("snapshot-refused.json");
        let mut receipt: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        match kind {
            0 => receipt["path"] = json!("PRIVATE_PATH"),
            1 => receipt["operation"] = json!("d".repeat(32)),
            2 => receipt["data"]["message"] = json!("PRIVATE_MESSAGE"),
            3 => receipt["data"]["error"]["code"] = json!("PRIVATE/path/token"),
            4 => receipt["data"]["version"] = json!(2),
            _ => receipt["data"]["error"]["finalization"] = json!((0..70).map(|_| json!({"code":"DEPLOYMENT_IO_UNAVAILABLE","snapshot":null,"finalization":[]})).collect::<Vec<_>>()),
        }
        fs::write(&path, serde_json::to_vec(&receipt).unwrap()).unwrap();
        let result = fixture.service.status(&fixture.next.plan.operation);
        fixture.close();
        assert_eq!(
            result.err().expect("unsafe diagnostic must refuse").code(),
            "DEPLOYMENT_DIAGNOSTIC_INVALID",
            "case {kind}"
        );
    }
}

#[test]
fn terminal_claim_handover_archives_exact_bytes_and_preserves_backup_facts() {
    let mut fixture = Fixture::new(false);
    let original = fixture.claim_bytes();
    let ready = fs::read(fixture.previous.directory.join("ready.json")).unwrap();
    let prepared = fixture
        .service
        .claim(&fixture.next, &fixture.current)
        .unwrap();
    prepared.finish(&fixture.next, &fixture.current).unwrap();
    assert_eq!(fixture.active(), fixture.next.plan.operation);
    assert_eq!(
        fs::read(fixture.next.directory.join("claim-before.json")).unwrap(),
        original
    );
    assert_eq!(
        fs::read(fixture.previous.directory.join("ready.json")).unwrap(),
        ready
    );
    assert_eq!(
        fixture.previous.status().unwrap().backup_verified,
        Some(false)
    );
    assert_eq!(fixture.previous.status().unwrap().stage, "SUPERSEDED");
    assert!(fixture.service.claimed(&fixture.previous).is_err());
    fixture.service.claimed(&fixture.next).unwrap();
    fixture.close();
}

#[test]
fn restored_claim_can_handover_only_to_the_original_restored_source() {
    let mut fixture = Fixture::new(true);
    let prepared = fixture
        .service
        .claim(&fixture.next, &fixture.current)
        .unwrap();
    prepared.finish(&fixture.next, &fixture.current).unwrap();
    assert_eq!(fixture.active(), fixture.next.plan.operation);
    assert_eq!(fixture.previous.status().unwrap().stage, "SUPERSEDED");
    fixture.close();
}

#[test]
fn unfinished_foreign_and_altered_terminal_claims_are_never_replaced() {
    for case in 0..10 {
        let mut fixture = Fixture::new(false);
        match case {
            0 => fs::remove_file(fixture.previous.directory.join("ready.json")).unwrap(),
            1 => fs::write(fixture.previous.directory.join("ready.json"), b"{}").unwrap(),
            2 => {
                fixture.current["Config"]["Env"] = json!(["REVERIE_NATIVE_FRONT=1", "FOREIGN=1"]);
                fixture.next.plan.source = fixture.current.clone();
            }
            3 => {
                fixture.previous.attempt("successor-attempt").unwrap();
            }
            4 => {
                fixture.current["Id"] = json!("d".repeat(64));
                fixture.next.plan.source = fixture.current.clone();
            }
            5 => {
                fixture.previous.attempt("rollback-attempt").unwrap();
            }
            6 => {
                fixture
                    .previous
                    .record("superseded", &json!({"invalid":true}))
                    .unwrap();
            }
            7 => {
                fixture.current["Name"] = json!("/foreign");
                fixture.next.plan.source = fixture.current.clone();
            }
            8 => {
                fs::write(
                    fixture.claim_path(),
                    format!(
                        "{{\"operation\":\"{}\",\"foreign\":true}}",
                        fixture.previous.plan.operation
                    ),
                )
                .unwrap();
            }
            _ => {
                fs::write(
                    fixture.claim_path(),
                    format!(
                        "{{\"operation\":\"{}\",\"operation\":\"{}\"}}",
                        fixture.previous.plan.operation, fixture.previous.plan.operation
                    ),
                )
                .unwrap();
            }
        }
        let before = fixture.claim_bytes();
        assert!(
            fixture
                .service
                .claim(&fixture.next, &fixture.current)
                .is_err(),
            "case {case}"
        );
        assert_eq!(fixture.claim_bytes(), before);
        fixture.close();
    }
}

#[test]
fn pending_handover_blocks_replay_and_retains_original_claim_after_source_drift() {
    let mut fixture = Fixture::new(false);
    let original = fixture.claim_bytes();
    let prepared = fixture
        .service
        .claim(&fixture.next, &fixture.current)
        .unwrap();
    fixture.current["State"]["Pid"] = json!(99);
    assert!(prepared.finish(&fixture.next, &fixture.current).is_err());
    assert_eq!(fixture.claim_bytes(), original);
    assert_eq!(
        fixture.previous.status().unwrap().stage,
        "CLAIM_HANDOVER_UNCONFIRMED"
    );
    assert!(fixture.service.claimed(&fixture.previous).is_err());
    assert!(
        fixture
            .service
            .claim(&fixture.next, &fixture.current)
            .is_err()
    );
    fixture.close();
}

#[test]
fn replaced_active_claim_and_update_lock_are_not_accepted_by_the_pending_owner() {
    for kind in 0..3 {
        let mut fixture = Fixture::new(false);
        let prepared = fixture
            .service
            .claim(&fixture.next, &fixture.current)
            .unwrap();
        let path = match kind {
            0 => fixture.claim_path(),
            1 => fixture.service.installation.state.join("update.lock"),
            _ => fixture.next.directory.join("claim-next.json"),
        };
        let bytes = fs::read(&path).unwrap();
        fs::rename(&path, path.with_extension("original")).unwrap();
        fs::write(&path, &bytes).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        assert!(prepared.finish(&fixture.next, &fixture.current).is_err());
        assert_eq!(fixture.active(), fixture.previous.plan.operation);
        fixture.close();
    }
}

#[test]
fn first_claim_remains_supported_without_an_active_predecessor() {
    let mut fixture = Fixture::new(false);
    fs::remove_file(fixture.claim_path()).unwrap();
    let prepared = fixture
        .service
        .claim(&fixture.next, &fixture.current)
        .unwrap();
    prepared.finish(&fixture.next, &fixture.current).unwrap();
    assert_eq!(fixture.active(), fixture.next.plan.operation);
    assert!(
        !fixture
            .previous
            .record_present("successor-attempt")
            .unwrap()
    );
    fixture.service.claimed(&fixture.next).unwrap();
    fixture.close();
}

#[test]
fn unknown_pending_name_never_looks_like_a_ready_or_replayable_claim() {
    use std::os::unix::fs::symlink;
    let mut fixture = Fixture::new(false);
    let prepared = fixture
        .service
        .claim(&fixture.next, &fixture.current)
        .unwrap();
    let path = fixture.previous.directory.join("successor-attempt.json");
    fs::rename(&path, path.with_extension("original")).unwrap();
    symlink("missing", &path).unwrap();
    assert!(prepared.finish(&fixture.next, &fixture.current).is_err());
    assert!(fixture.previous.status().is_err());
    assert!(fixture.service.claimed(&fixture.previous).is_err());
    assert!(
        fixture
            .service
            .claim(&fixture.next, &fixture.current)
            .is_err()
    );
    assert_eq!(fixture.active(), fixture.previous.plan.operation);
    fixture.close();
}

#[test]
fn foreign_file_before_capture_never_becomes_the_original_written_owner() {
    let mut outcomes = Vec::new();
    for kind in 0..3 {
        let mut fixture = Fixture::new(false);
        let mut prepared = fixture
            .service
            .claim(&fixture.next, &fixture.current)
            .unwrap();
        let successor = prepared.successor.as_ref().unwrap();
        let original = match kind {
            0 => &successor.pending,
            1 => &successor.archived,
            _ => &successor.replacement,
        };
        let path = original.path.clone();
        let expected = original.bytes.clone();
        // Model the exact writer→capture window: a real foreign private file is
        // present before the production reader captures its named baseline.
        fs::rename(&path, path.with_extension("original")).unwrap();
        fs::write(&path, format!("{{\"operation\":\"{}\"}}", "d".repeat(32))).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        let adopted = file::ClaimFile::capture_written(path, &expected);
        let refused = if let Ok(adopted) = adopted {
            let successor = prepared.successor.as_mut().unwrap();
            match kind {
                0 => successor.pending = adopted,
                1 => successor.archived = adopted,
                _ => successor.replacement = adopted,
            }
            prepared.finish(&fixture.next, &fixture.current).is_err()
        } else {
            drop(prepared);
            true
        };
        let unchanged = fixture.active() == fixture.previous.plan.operation;
        let pending = fixture
            .previous
            .record_present("successor-attempt")
            .unwrap();
        fixture.close();
        outcomes.push((kind, refused, unchanged, pending));
    }
    assert_eq!(
        outcomes,
        vec![
            (0, true, true, true),
            (1, true, true, true),
            (2, true, true, true)
        ]
    );
}
