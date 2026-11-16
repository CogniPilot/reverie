use super::*;
use crate::model::DeploymentPreview;
use std::{fs, path::Path};
mod fixture;
use fixture::Fixture;

fn namespace(test: &str, scenario: fn()) {
    crate::test_namespace::run(
        &format!("service::rollback::network_tests::{test}"),
        scenario,
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
            let result = fixture.operation.claim_terminal(&fixture.drifted());
            assert_eq!(result.err().unwrap().code(), "DEPLOYMENT_NETWORK_CHANGED");
            assert!(!fixture.operation.exists("superseded"));
            fixture.close();
        },
    );
}
