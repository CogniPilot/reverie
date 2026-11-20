use super::*;
use crate::model::DeploymentPreview;
use std::{fs, path::Path};
pub(in crate::service) mod fixture;
use fixture::Fixture;

fn namespace(test: &str, scenario: fn()) {
    crate::test_namespace::run(
        &format!("service::rollback::network_tests::{test}"),
        scenario,
    );
}
#[test]
fn absent_candidate_before_any_lifecycle_attempt_closes_original_running_source() {
    namespace(
        "absent_candidate_before_any_lifecycle_attempt_closes_original_running_source",
        || {
            let fixture = Fixture::missing_candidate();
            let status = fixture
                .service
                .rollback(&fixture.operation.plan.operation)
                .unwrap();
            assert_eq!(status.stage, "RESTORED");
            let receipt: Value = serde_json::from_slice(
                &fs::read(fixture.operation.directory.join("restored.json")).unwrap(),
            )
            .unwrap();
            assert_eq!(receipt["data"]["missingCandidate"], "b".repeat(64));
            assert!(receipt["data"].get("retainedCandidate").is_none());
            assert!(
                fixture
                    .port
                    .calls()
                    .iter()
                    .all(|call| call.starts_with("GET "))
            );
            assert_eq!(
                fixture
                    .operation
                    .claim_terminal(&fixture.source, None, &fixture.service.engine)
                    .unwrap(),
                "RESTORED"
            );
            assert_eq!(
                fixture
                    .service
                    .status(&fixture.operation.plan.operation)
                    .unwrap()
                    .stage,
                "RESTORED"
            );
            fixture.close_adoption();
        },
    );
}
#[test]
fn missing_candidate_never_closes_any_prior_native_lifecycle_attempt() {
    namespace(
        "missing_candidate_never_closes_any_prior_native_lifecycle_attempt",
        || {
            let fixture = Fixture::missing_candidate();
            for marker in [
                "stop-attempt",
                "snapshot",
                "old-rename-attempt",
                "old-renamed",
                "new-rename-attempt",
                "new-renamed",
                "start-attempt",
                "started",
                "ready",
                "rollback-attempt",
            ] {
                fixture.operation.attempt(marker).unwrap();
                assert!(
                    fixture
                        .service
                        .rollback(&fixture.operation.plan.operation)
                        .is_err(),
                    "{marker}"
                );
                assert!(!fixture.operation.exists("restored"), "{marker}");
                fs::remove_file(fixture.operation.directory.join(format!("{marker}.json")))
                    .unwrap();
            }
            assert!(
                fixture
                    .port
                    .calls()
                    .iter()
                    .all(|call| call.starts_with("GET "))
            );
            fixture.close();
        },
    );
}
#[test]
fn candidate_refusal_or_reappearance_is_never_absence() {
    namespace("candidate_refusal_or_reappearance_is_never_absence", || {
        let fixture = Fixture::missing_candidate();
        for status in [403, 500] {
            fixture.port.replies(
                &"b".repeat(64),
                vec![(status, json!({"message":"not found"}))],
            );
            assert!(
                fixture
                    .service
                    .rollback(&fixture.operation.plan.operation)
                    .is_err()
            );
            assert!(!fixture.operation.exists("rollback-attempt"));
        }
        fixture.port.replies(
            &"b".repeat(64),
            vec![
                (404, json!({"message":"gone"})),
                (200, json!({"Id":"b".repeat(64)})),
            ],
        );
        assert!(
            fixture
                .service
                .rollback(&fixture.operation.plan.operation)
                .is_err()
        );
        assert!(!fixture.operation.exists("restored"));
        assert!(
            fixture
                .port
                .calls()
                .iter()
                .all(|call| call.starts_with("GET "))
        );
        fixture.close_adoption();
    });
}
#[test]
fn missing_candidate_source_epoch_name_and_config_drift_remain_held() {
    namespace(
        "missing_candidate_source_epoch_name_and_config_drift_remain_held",
        || {
            let fixture = Fixture::missing_candidate();
            for change in ["epoch", "name", "image", "config"] {
                let mut source = fixture.source.clone();
                match change {
                    "epoch" => source["State"]["StartedAt"] = json!("foreign epoch"),
                    "name" => source["Name"] = json!("/foreign"),
                    "image" => source["Image"] = json!(format!("sha256:{}", "9".repeat(64))),
                    _ => source["Config"]["Env"] = json!(["FOREIGN=1"]),
                }
                fixture
                    .port
                    .set(format!("/containers/{}/json", "a".repeat(64)), source);
                assert!(
                    fixture
                        .service
                        .rollback(&fixture.operation.plan.operation)
                        .is_err(),
                    "{change}"
                );
                assert!(!fixture.operation.exists("rollback-attempt"));
            }
            assert!(!fixture.operation.exists("restored"));
            assert!(
                fixture
                    .port
                    .calls()
                    .iter()
                    .all(|call| call.starts_with("GET "))
            );
            fixture.close();
        },
    );
}
#[test]
fn missing_candidate_final_absence_recheck_refuses_without_terminal_receipt() {
    namespace(
        "missing_candidate_final_absence_recheck_refuses_without_terminal_receipt",
        || {
            let fixture = Fixture::missing_candidate();
            fixture.port.replies(
                &"b".repeat(64),
                vec![
                    (404, json!({"message":"gone"})),
                    (404, json!({"message":"gone"})),
                    (200, json!({"Id":"b".repeat(64)})),
                ],
            );
            assert!(
                fixture
                    .service
                    .rollback(&fixture.operation.plan.operation)
                    .is_err()
            );
            assert!(fixture.operation.exists("rollback-attempt"));
            assert!(!fixture.operation.exists("restored"));
            assert!(
                fixture
                    .port
                    .calls()
                    .iter()
                    .all(|call| call.starts_with("GET "))
            );
            fixture.close_adoption();
        },
    );
}
#[test]
fn missing_candidate_final_source_bookend_refuses_late_epoch_drift() {
    namespace(
        "missing_candidate_final_source_bookend_refuses_late_epoch_drift",
        || {
            let fixture = Fixture::missing_candidate();
            for field in ["StartedAt", "Pid", "Name"] {
                let mut changed = fixture.source.clone();
                match field {
                    "StartedAt" => changed["State"][field] = json!("late foreign epoch"),
                    "Pid" => changed["State"][field] = json!(1),
                    _ => changed[field] = json!("/foreign"),
                }
                fixture.port.set_sequence(
                    format!("/containers/{}/json", "a".repeat(64)),
                    vec![
                        fixture.source.clone(),
                        fixture.source.clone(),
                        fixture.source.clone(),
                        changed,
                    ],
                );
                assert!(
                    fixture
                        .service
                        .rollback(&fixture.operation.plan.operation)
                        .is_err()
                );
                assert!(!fixture.operation.exists("restored"));
                assert!(!fixture.operation.exists("rollback-attempt"));
            }
            assert!(
                fixture
                    .port
                    .calls()
                    .iter()
                    .all(|call| call.starts_with("GET "))
            );
            fixture.close_adoption();
        },
    );
}
#[test]
fn missing_candidate_rejects_changed_original_bind_permissions() {
    namespace(
        "missing_candidate_rejects_changed_original_bind_permissions",
        || {
            use std::os::unix::fs::PermissionsExt;
            let fixture = Fixture::missing_candidate();
            let path = Path::new("/tmp/deployment/data");
            let original = fs::metadata(path).unwrap().permissions();
            fs::set_permissions(path, fs::Permissions::from_mode(original.mode() ^ 0o010)).unwrap();
            let result = fixture.service.rollback(&fixture.operation.plan.operation);
            fs::set_permissions(path, original).unwrap();
            assert!(result.is_err());
            assert!(!fixture.operation.exists("rollback-attempt"));
            assert!(!fixture.operation.exists("restored"));
            assert!(
                fixture
                    .port
                    .calls()
                    .iter()
                    .all(|call| call.starts_with("GET "))
            );
            fixture.close();
        },
    );
}
#[test]
fn missing_candidate_rechecks_original_live_account_writers() {
    namespace(
        "missing_candidate_rechecks_original_live_account_writers",
        || {
            let fixture = Fixture::missing_live_accounts();
            let id = "d".repeat(64);
            let mut worker = fixture::worker();
            worker["Config"]["Env"] = json!(["FOREIGN=1"]);
            fixture.port.set(format!("/containers/{id}/json"), worker);
            assert!(
                fixture
                    .service
                    .rollback(&fixture.operation.plan.operation)
                    .is_err()
            );
            assert!(!fixture.operation.exists("rollback-attempt"));
            assert!(!fixture.operation.exists("restored"));
            assert!(
                fixture
                    .port
                    .calls()
                    .iter()
                    .all(|call| call.starts_with("GET "))
            );
            fixture.close_adoption();
        },
    );
}
#[test]
fn missing_candidate_unhealthy_source_cannot_publish_restored() {
    namespace(
        "missing_candidate_unhealthy_source_cannot_publish_restored",
        || {
            let fixture = Fixture::missing_candidate();
            fixture.refuse_health();
            assert!(
                fixture
                    .service
                    .rollback(&fixture.operation.plan.operation)
                    .is_err()
            );
            assert!(!fixture.operation.exists("rollback-attempt"));
            assert!(!fixture.operation.exists("restored"));
            assert!(
                fixture
                    .port
                    .calls()
                    .iter()
                    .all(|call| call.starts_with("GET "))
            );
            fixture.close_adoption();
        },
    );
}
#[test]
fn version_four_reaches_the_actual_effect_entrypoint() {
    namespace("version_four_reaches_the_actual_effect_entrypoint", || {
        let fixture = Fixture::new();
        let selected = fixture
            .service
            .effect_operation(&fixture.operation.plan.operation)
            .unwrap();
        assert_eq!(selected.plan.version, 4);
        assert!(fixture.port.calls().is_empty()); // No create/start is performed by this check.
        fixture.close();
    });
}
#[test]
fn rollback_endpoint_drift_refuses_before_original_start_or_terminal_record() {
    namespace(
        "rollback_endpoint_drift_refuses_before_original_start_or_terminal_record",
        || {
            let fixture = Fixture::new();
            fixture.port.set(
                format!("/containers/{}/json", "a".repeat(64)),
                fixture.drifted(),
            );
            let result = fixture.service.rollback(&fixture.operation.plan.operation);
            let calls = fixture.port.calls();
            assert_eq!(
                result.err().unwrap().code(),
                "DEPLOYMENT_NETWORK_CHANGED",
                "{calls:?}"
            );
            assert!(
                !calls.iter().any(|call| call.starts_with("POST ")),
                "{calls:?}"
            );
            assert!(!fixture.operation.exists("restored"));
            fixture.close();
        },
    );
}
#[test]
fn final_restored_writer_rechecks_original_endpoints() {
    namespace("final_restored_writer_rechecks_original_endpoints", || {
        let fixture = Fixture::new();
        let pins = crate::pins::Pins::capture(&fixture.operation.plan.source).unwrap();
        let mut observed = fixture.drifted();
        observed["State"]["Running"] = json!(true);
        observed["State"]["Pid"] = json!(std::process::id());
        let result =
            fixture
                .service
                .publish_restored(&fixture.operation, &"b".repeat(64), &observed, &pins);
        assert_eq!(result.err().unwrap().code(), "DEPLOYMENT_NETWORK_CHANGED");
        assert!(!fixture.operation.exists("restored"));
        assert!(fixture.port.calls().is_empty());
        pins.close().unwrap();
        fixture.close();
    });
}
#[test]
fn restored_status_is_unconfirmed_at_endpoint_drift_before_health_reads() {
    namespace(
        "restored_status_is_unconfirmed_at_endpoint_drift_before_health_reads",
        || {
            let fixture = Fixture::new();
            fixture.operation.attempt("rollback-attempt").unwrap();
            fixture.operation.record("restored", &json!({"containerId":"a".repeat(64),"dataRestored":false,"brokerChanged":false})).unwrap();
            let mut observed = fixture.drifted();
            observed["State"]["Running"] = json!(true);
            observed["State"]["Pid"] = json!(std::process::id());
            fixture
                .port
                .set(format!("/containers/{}/json", "a".repeat(64)), observed);
            let status = fixture
                .service
                .status(&fixture.operation.plan.operation)
                .unwrap();
            assert_eq!(status.stage, "READINESS_UNCONFIRMED");
            let failure = status.readiness_failure.unwrap();
            assert_eq!(failure.recorded_stage, "RESTORED");
            assert_eq!(
                failure.diagnostic["error"]["code"],
                "DEPLOYMENT_NETWORK_CHANGED"
            );
            assert_eq!(
                fixture.port.calls(),
                vec![format!("GET /containers/{}/json", "a".repeat(64))]
            );
            fixture.close();
        },
    );
}
#[test]
fn restored_claim_never_hands_over_a_changed_original_network() {
    namespace(
        "restored_claim_never_hands_over_a_changed_original_network",
        || {
            let fixture = Fixture::new();
            fixture.operation.attempt("rollback-attempt").unwrap();
            fixture.operation.record("restored", &json!({"containerId":"a".repeat(64),"dataRestored":false,"brokerChanged":false})).unwrap();
            assert_eq!(
                model::projection(&fixture.drifted()),
                model::projection(&fixture.operation.plan.source)
            );
            let result =
                fixture
                    .operation
                    .claim_terminal(&fixture.drifted(), None, &fixture.service.engine);
            assert_eq!(result.err().unwrap().code(), "DEPLOYMENT_NETWORK_CHANGED");
            assert!(!fixture.operation.exists("superseded"));
            fixture.close();
        },
    );
}

#[test]
fn ready_claim_preserves_a_new_employee_bridge_only_with_matching_live_members() {
    namespace(
        "ready_claim_preserves_a_new_employee_bridge_only_with_matching_live_members",
        || {
            let fixture = Fixture::new();
            let console_id = "b".repeat(64);
            fixture.operation.record(
                "ready",
                &json!({"mode":"hybrid-rust-front","brokerChanged":false,"containerId":console_id}),
            ).unwrap();
            let mut website = fixture.service.engine.container(&console_id).unwrap();
            website["Name"] = json!("/fixture");
            let (network, worker) = added_worker_bridge(&console_id);
            let network_name = network["Name"].as_str().unwrap();
            let network_id = network["Id"].as_str().unwrap();
            let network_path = format!("/networks/{network_id}");
            let worker_path = format!("/containers/{}/json", worker["Id"].as_str().unwrap());
            website["NetworkSettings"]["Networks"][network_name] =
                json!({"NetworkID":network_id,"Aliases":["fixture"]});
            fixture.port.set(network_path.clone(), network.clone());
            fixture.port.set(worker_path.clone(), worker.clone());
            let engine = &fixture.service.engine;
            let current = crate::networks::Topology::capture(&website, engine).unwrap();
            let claim = || {
                fixture
                    .operation
                    .claim_terminal(&website, Some(&current), engine)
            };
            assert_eq!(claim().unwrap(), "HYBRID_READY");
            assert_eq!(
                current.request().unwrap()["EndpointsConfig"][network_name]["NetworkID"],
                network_id
            );

            let mut extra_member = network.clone();
            extra_member["Containers"]["e".repeat(64)] = json!({"Name":"unrelated"});
            fixture
                .port
                .set_sequence(network_path.clone(), vec![network.clone(), extra_member]);
            assert_eq!(claim().unwrap_err().code(), "DEPLOYMENT_NETWORK_CHANGED");

            fixture.port.set(network_path, network);
            let mut foreign = worker.clone();
            foreign["Config"]["Labels"]["reverie.boxed.instance"] = json!("different-office");
            fixture.port.set(worker_path, foreign);
            assert_eq!(claim().unwrap_err().code(), "DEPLOYMENT_NETWORK_CHANGED");

            assert!(
                fixture
                    .port
                    .calls()
                    .iter()
                    .all(|call| call.starts_with("GET "))
            );
            fixture.close();
        },
    );
}

fn added_worker_bridge(console_id: &str) -> (Value, Value) {
    let id = "3".repeat(64);
    let name = "reverie-boxed-api-12345678-bootstrap";
    let employee = "12345678-1111-4111-8111-111111111111";
    let operation = "22345678-2222-4222-8222-222222222222";
    let worker_id = "d".repeat(64);
    let box_id = "f".repeat(64);
    let identity = serde_json::to_vec(&[box_id.as_str(), "destination", operation]).unwrap();
    let worker_name = format!("reverie-boxed-{}", crate::installation::digest(&identity));
    let network = json!({"Id":id,"Name":name,"Driver":"bridge","Scope":"local",
        "Ingress":false,"ConfigOnly":false,"Labels":{"reverie.boxed.employee":employee},
        "Containers":{console_id:{"Name":"fixture"},(&worker_id):{"Name":worker_name}}});
    let worker = json!({"Id":worker_id,"Name":format!("/{worker_name}"),
        "Config":{"Entrypoint":["/opt/reverie/perf/bin/reverie-worker-init"],
            "Labels":{"reverie.boxed.instance":"fixture","reverie.boxed.employee":employee,
                "reverie.boxed.operation":operation,"reverie.boxed.box":box_id}},
        "NetworkSettings":{"Networks":{name:{"NetworkID":id}}}});
    (network, worker)
}
