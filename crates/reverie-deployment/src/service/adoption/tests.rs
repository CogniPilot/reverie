//! Real owner service/root-peer transport and private journal; controlled
//! external Engine/health facts are not an actual Docker deployment claim.
use super::*;
use crate::service::rollback::network_tests::fixture::{Fixture, image};
use std::fs;

fn namespace(name: &str, scenario: fn()) {
    crate::test_namespace::run(&format!("service::adoption::tests::{name}"), scenario);
}
fn preview(f: &Fixture) -> Result<DeploymentPreview> {
    f.service.preview_adopting_stale_claim(
        image('f')["Id"].as_str().unwrap(),
        DeploymentProfile::Ordinary,
        DeploymentPreviewMode::PreserveNetworks,
        &f.operation.plan.operation,
        &"e".repeat(64),
    )
}
fn active(f: &Fixture) -> String {
    claim::selected(&f.service.installation).unwrap()
}
fn no_effect(f: &Fixture) {
    assert!(f.port.calls().iter().all(|call| call.starts_with("GET ")));
}
#[test]
fn stale_claim_adoption_composes_with_exact_live_account_writer_disposition() {
    namespace(
        "stale_claim_adoption_composes_with_exact_live_account_writer_disposition",
        || {
            let f = Fixture::adopting();
            let worker = crate::service::rollback::network_tests::fixture::worker();
            f.port.set(
                format!("/containers/{}/json", "d".repeat(64)),
                worker.clone(),
            );
            f.port.set("/containers/json".into(),json!([
            {"Id":f.source["Id"],"State":"running","ImageID":f.source["Image"],"Mounts":f.source["Mounts"]},
            {"Id":worker["Id"],"State":"running","ImageID":worker["Image"],"Mounts":worker["Mounts"]}
        ]));
            assert!(preview(&f).is_err()); // Ordinary shared-writer refusal remains.
            let p = f
                .service
                .preview_adopting_stale_claim(
                    image('f')["Id"].as_str().unwrap(),
                    DeploymentProfile::Ordinary,
                    DeploymentPreviewMode::LiveAccountsFixForward,
                    &f.operation.plan.operation,
                    &"e".repeat(64),
                )
                .unwrap();
            assert_eq!(p.live_accounts.as_ref().unwrap().writers.len(), 1);
            let op = f.service.effect_operation(&p.operation).unwrap();
            assert_eq!(op.plan.version, 6);
            assert!(op.plan.live_account_writers.is_some());
            assert_eq!(
                f.service.prepare(&p.operation).err().unwrap().code(),
                "DEPLOYMENT_ENGINE_REFUSED"
            );
            assert_eq!(active(&f), p.operation);
            assert_eq!(
                f.port
                    .calls()
                    .iter()
                    .filter(|call| call.starts_with("POST "))
                    .count(),
                1
            );
            assert!(
                !f.port
                    .calls()
                    .iter()
                    .any(|call| call.contains("/stop") || call.contains("/start"))
            );
            f.close_adoption();
        },
    );
}
#[test]
fn current_status_refusal_after_archive_cannot_handover_claim() {
    namespace(
        "current_status_refusal_after_archive_cannot_handover_claim",
        || {
            let f = Fixture::adopting();
            let p = preview(&f).unwrap();
            let op = f.service.operation(&p.operation).unwrap();
            let prepared = f.service.claim(&op, &f.source).unwrap();
            f.refuse_health();
            assert_eq!(
                prepared.finish(&op, &f.source).unwrap_err().code(),
                "DEPLOYMENT_ADOPTION_HEALTH_UNCONFIRMED"
            );
            assert_eq!(active(&f), f.operation.plan.operation);
            assert!(!op.record_present("create-attempt").unwrap());
            no_effect(&f);
            f.close_adoption();
        },
    );
}
#[test]
fn actual_prepare_hands_over_once_before_its_single_candidate_create_attempt() {
    namespace(
        "actual_prepare_hands_over_once_before_its_single_candidate_create_attempt",
        || {
            let f = Fixture::adopting();
            let p = preview(&f).unwrap();
            f.port.clear();
            let error = f
                .service
                .prepare(&p.operation)
                .err()
                .expect("controlled CREATE refuses");
            assert_eq!(error.code(), "DEPLOYMENT_ENGINE_REFUSED"); // controlled POST refuses
            assert_eq!(active(&f), p.operation);
            let before = f.port.calls();
            assert_eq!(
                before
                    .iter()
                    .filter(|call| call.starts_with("POST "))
                    .count(),
                1
            );
            assert!(
                before
                    .iter()
                    .any(|call| call.starts_with("POST /containers/create?name="))
            );
            let op = f.service.operation(&p.operation).unwrap();
            assert!(op.record_present("create-attempt").unwrap());
            assert!(op.record_present("claim-acquired").unwrap());
            assert!(f.service.prepare(&p.operation).is_err());
            assert_eq!(
                f.port
                    .calls()
                    .iter()
                    .filter(|call| call.starts_with("POST "))
                    .count(),
                1
            );
            f.close_adoption();
        },
    );
}
#[test]
fn stale_ready_adoption_preserves_old_receipt_and_moves_only_the_claim() {
    namespace(
        "stale_ready_adoption_preserves_old_receipt_and_moves_only_the_claim",
        || {
            let f = Fixture::adopting();
            let old = fs::read(f.operation.directory.join("ready.json")).unwrap();
            let p = preview(&f).unwrap();
            assert_eq!(active(&f), f.operation.plan.operation);
            let op = f.service.effect_operation(&p.operation).unwrap();
            assert_eq!(op.plan.version, 6);
            assert!(
                p.claim_adoption
                    .unwrap()
                    .continuity_scope
                    .contains("unproven")
            );
            let prepared = f.service.claim(&op, &f.source).unwrap();
            assert_eq!(active(&f), f.operation.plan.operation);
            prepared.finish(&op, &f.source).unwrap();
            assert_eq!(active(&f), p.operation);
            assert_eq!(
                old,
                fs::read(f.operation.directory.join("ready.json")).unwrap()
            );
            assert!(op.record_present("claim-acquired").unwrap());
            assert!(f.operation.record_present("superseded").unwrap());
            assert!(f.service.claim(&op, &f.source).is_err());
            assert!(!op.record_present("create-attempt").unwrap());
            no_effect(&f);
            f.close_adoption();
        },
    );
}
#[test]
fn adoption_reobserves_absence_after_archive_and_retains_uncertain_original_attempt() {
    namespace(
        "adoption_reobserves_absence_after_archive_and_retains_uncertain_original_attempt",
        || {
            let f = Fixture::adopting();
            let p = preview(&f).unwrap();
            let op = f.service.operation(&p.operation).unwrap();
            let prepared = f.service.claim(&op, &f.source).unwrap();
            assert!(op.directory.join("claim-before.json").exists());
            f.port.set(
                format!("/containers/{}/json", "b".repeat(64)),
                json!({"Id":"b".repeat(64)}),
            );
            assert_eq!(
                prepared.finish(&op, &f.source).unwrap_err().code(),
                "DEPLOYMENT_OLD_CONTAINER_ABSENCE_UNCONFIRMED"
            );
            assert_eq!(active(&f), f.operation.plan.operation);
            assert!(f.operation.record_present("successor-attempt").unwrap());
            assert!(f.service.claim(&op, &f.source).is_err());
            assert!(preview(&f).is_err());
            assert!(!op.record_present("create-attempt").unwrap());
            no_effect(&f);
            f.close_adoption();
        },
    );
}
#[test]
fn adoption_rejects_current_drift_after_archive_and_claim_file_replacement() {
    namespace(
        "adoption_rejects_current_drift_after_archive_and_claim_file_replacement",
        || {
            let f = Fixture::adopting();
            let p = preview(&f).unwrap();
            let op = f.service.operation(&p.operation).unwrap();
            let prepared = f.service.claim(&op, &f.source).unwrap();
            let mut changed = f.source.clone();
            changed["State"]["StartedAt"] = json!("new-incarnation");
            f.port.set("/containers/fixture/json".into(), changed);
            assert_eq!(
                prepared.finish(&op, &f.source).unwrap_err().code(),
                "DEPLOYMENT_ADOPTION_CURRENT_CHANGED"
            );
            assert_eq!(active(&f), f.operation.plan.operation);
            no_effect(&f);
            f.close_adoption();
        },
    );
}
#[test]
fn adoption_refuses_downgraded_selection_and_changed_terminal_receipt() {
    namespace(
        "adoption_refuses_downgraded_selection_and_changed_terminal_receipt",
        || {
            let f = Fixture::adopting();
            let p = preview(&f).unwrap();
            let mut op = f.service.operation(&p.operation).unwrap();
            op.plan.version = 5;
            assert_eq!(
                op.plan.require_effect().unwrap_err().code(),
                "DEPLOYMENT_OPERATION_INVALID"
            );
            op.plan.version = 6;
            let prepared = f.service.claim(&op, &f.source).unwrap();
            let path = f.operation.directory.join("ready.json");
            let mut bytes = fs::read(&path).unwrap();
            bytes.push(b' ');
            fs::write(&path, bytes).unwrap();
            assert_eq!(
                prepared.finish(&op, &f.source).unwrap_err().code(),
                "DEPLOYMENT_ADOPTION_PREDECESSOR_CHANGED"
            );
            assert_eq!(active(&f), f.operation.plan.operation);
            no_effect(&f);
            f.close_adoption();
        },
    );
}
#[test]
fn adoption_requires_explicit_current_and_all_declared_core_grants() {
    namespace(
        "adoption_requires_explicit_current_and_all_declared_core_grants",
        || {
            let f = Fixture::adopting();
            assert!(
                f.service
                    .preview_adopting_stale_claim(
                        image('f')["Id"].as_str().unwrap(),
                        DeploymentProfile::Ordinary,
                        DeploymentPreviewMode::PreserveNetworks,
                        &f.operation.plan.operation,
                        &"f".repeat(64)
                    )
                    .is_err()
            );
            let mut changed = f.source.clone();
            changed["Mounts"][1]["RW"] = json!(false);
            f.port.set("/containers/fixture/json".into(), changed);
            assert!(preview(&f).is_err());
            assert_eq!(active(&f), f.operation.plan.operation);
            no_effect(&f);
            f.close();
        },
    );
}
#[test]
fn adoption_rejects_replaced_active_claim_without_starting_anything() {
    namespace(
        "adoption_rejects_replaced_active_claim_without_starting_anything",
        || {
            let f = Fixture::adopting();
            let p = preview(&f).unwrap();
            let op = f.service.operation(&p.operation).unwrap();
            let prepared = f.service.claim(&op, &f.source).unwrap();
            let path = f
                .service
                .installation
                .state
                .join("console-deployment-active.json");
            let bytes = fs::read(&path).unwrap();
            fs::rename(&path, path.with_extension("retained")).unwrap();
            installation::exclusive_bytes(&path, &bytes).unwrap();
            assert!(prepared.finish(&op, &f.source).is_err());
            assert_eq!(active(&f), f.operation.plan.operation);
            assert!(!op.record_present("create-attempt").unwrap());
            no_effect(&f);
            f.close_adoption();
        },
    );
}
#[test]
fn adoption_lost_handover_receipt_holds_original_id_after_atomic_rename() {
    namespace(
        "adoption_lost_handover_receipt_holds_original_id_after_atomic_rename",
        || {
            let f = Fixture::adopting();
            let p = preview(&f).unwrap();
            let op = f.service.operation(&p.operation).unwrap();
            let prepared = f.service.claim(&op, &f.source).unwrap();
            // Real filesystem failure AFTER the active-claim rename, before receipt ACK.
            fs::create_dir(op.directory.join("claim-acquired.json")).unwrap();
            assert!(prepared.finish(&op, &f.source).is_err());
            assert_eq!(active(&f), p.operation);
            assert!(f.operation.record_present("successor-attempt").unwrap());
            assert!(op.directory.join("claim-before.json").exists());
            assert!(f.service.prepare(&p.operation).is_err());
            assert!(!op.record_present("create-attempt").unwrap());
            assert!(!f.operation.record_present("superseded").unwrap());
            no_effect(&f);
            f.close_adoption();
        },
    );
}
#[test]
fn adoption_refuses_rollback_pending_and_nonterminal_or_foreign_ready_receipts() {
    namespace(
        "adoption_refuses_rollback_pending_and_nonterminal_or_foreign_ready_receipts",
        || {
            let f = Fixture::adopting();
            let path = f.operation.directory.join("ready.json");
            let original = fs::read(&path).unwrap();
            for field in ["mode", "brokerChanged", "containerId", "operation"] {
                let mut receipt: Value = serde_json::from_slice(&original).unwrap();
                let value = if field == "brokerChanged" {
                    json!(true)
                } else {
                    json!("foreign")
                };
                if field == "operation" {
                    receipt[field] = json!("f".repeat(32));
                } else {
                    receipt["data"][field] = value;
                }
                fs::write(&path, serde_json::to_vec(&receipt).unwrap()).unwrap();
                assert!(preview(&f).is_err(), "{field}");
            }
            fs::write(&path, &original).unwrap();
            f.operation.attempt("rollback-attempt").unwrap();
            assert!(preview(&f).is_err());
            assert_eq!(active(&f), f.operation.plan.operation);
            no_effect(&f);
            f.close();
        },
    );
}
#[test]
fn adoption_refuses_missing_native_process_and_missing_old_source_absence() {
    namespace(
        "adoption_refuses_missing_native_process_and_missing_old_source_absence",
        || {
            let f = Fixture::adopting();
            f.port.set(
                format!("/containers/{}/json", "a".repeat(64)),
                json!({"message":"not found"}),
            );
            assert_eq!(
                preview(&f).err().unwrap().code(),
                "DEPLOYMENT_OLD_CONTAINER_ABSENCE_UNCONFIRMED"
            );
            f.port.absent(&"a".repeat(64));
            f.port.set(
                format!(
                    "/containers/{}/top?ps_args=-eo%20pid,ppid,comm",
                    "e".repeat(64)
                ),
                json!({"Processes":[["1","0","node"]]}),
            );
            assert_eq!(
                preview(&f).err().unwrap().code(),
                "DEPLOYMENT_FRONT_PROCESS_UNCONFIRMED"
            );
            assert_eq!(active(&f), f.operation.plan.operation);
            no_effect(&f);
            f.close();
        },
    );
}
