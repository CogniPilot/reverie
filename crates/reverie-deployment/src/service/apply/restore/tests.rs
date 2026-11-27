//! Actual service and transport over controlled Engine observations; no real
//! Docker. Each case leaves the original console where a failed apply would.
use super::*;
use crate::service::rollback::network_tests::fixture::Fixture;

fn namespace(test: &str, scenario: fn()) {
    crate::test_namespace::run(&format!("service::apply::restore::tests::{test}"), scenario);
}
fn source_id() -> String {
    "a".repeat(64)
}
fn candidate_id() -> String {
    "b".repeat(64)
}
fn stop(id: &str) -> String {
    format!("POST /containers/{id}/stop?t=30")
}
fn start(id: &str) -> String {
    format!("POST /containers/{id}/start")
}
fn rename(id: &str, name: &str) -> String {
    format!("POST /containers/{id}/rename?name={name}")
}
fn running(mut container: Value) -> Value {
    container["State"]["Running"] = json!(true);
    container["State"]["Status"] = json!("running");
    container["State"]["Pid"] = json!(std::process::id());
    container["State"]["StartedAt"] = json!("started again");
    container
}
fn stopped(mut container: Value) -> Value {
    container["State"]["Running"] = json!(false);
    container["State"]["Status"] = json!("exited");
    container["State"]["Pid"] = json!(0);
    container
}
fn named(mut container: Value, name: &str) -> Value {
    container["Name"] = json!(format!("/{name}"));
    container
}
fn candidate(f: &Fixture) -> Value {
    let value = f.service.engine.container(&candidate_id()).unwrap();
    f.port.clear();
    value
}
fn observe(f: &Fixture, id: &str, value: Value) {
    f.port.set(format!("/containers/{id}/json"), value);
}
fn journal(f: &Fixture, markers: &[&str]) {
    for marker in markers {
        f.operation.attempt(marker).unwrap();
    }
}
fn rehearsal_refused() -> DeploymentError {
    DeploymentError::snapshot(
        "DEPLOYMENT_RESTORE_REHEARSAL_REFUSED",
        std::io::Error::other("controlled rehearsal refusal").into(),
    )
}
/// The failure of an apply that journaled its own stop.
fn restore(f: &Fixture, failure: DeploymentError) -> DeploymentError {
    let pins = f.service.pins(&f.operation).unwrap();
    let result = f
        .service
        .restoring_source(&f.operation, &pins, false, Err::<(), _>(failure));
    pins.close().unwrap();
    result.unwrap_err()
}
fn status(f: &Fixture) -> DeploymentStatus {
    f.service.status(&f.operation.plan.operation).unwrap()
}
fn restore_code(error: &DeploymentError) -> Option<&'static str> {
    error
        .source_restore()
        .and_then(SourceRestore::cause)
        .map(DeploymentError::code)
}

#[test]
fn a_refused_rehearsal_after_the_stop_starts_the_original_console_again() {
    namespace(
        "a_refused_rehearsal_after_the_stop_starts_the_original_console_again",
        || {
            let f = Fixture::new();
            let source = source_id();
            journal(&f, &["stop-attempt"]);
            f.port.effect(
                start(&source),
                vec![(source.as_str(), running(f.source.clone()))],
            );
            f.ready_source();
            let error = restore(&f, rehearsal_refused());
            assert_eq!(error.code(), "DEPLOYMENT_RESTORE_REHEARSAL_REFUSED");
            assert!(matches!(
                error.source_restore(),
                Some(SourceRestore::Restored)
            ));
            assert_eq!(f.port.posts(), vec![start(&source)]);
            let status = status(&f);
            assert_eq!(status.stage, "RESTORED");
            let decision = status.automatic_restore.unwrap();
            assert_eq!(decision["decision"], "ADMITTED");
            assert_eq!(decision["outcome"], "RESTORED");
            assert_eq!(
                decision["cause"]["error"]["code"],
                "DEPLOYMENT_RESTORE_REHEARSAL_REFUSED"
            );
            assert_eq!(
                decision["cause"]["error"]["snapshot"]["code"],
                "SNAPSHOT_IO"
            );
            f.close_adoption();
        },
    );
}

#[test]
fn a_failure_between_the_two_renames_returns_the_name_and_starts_the_original() {
    namespace(
        "a_failure_between_the_two_renames_returns_the_name_and_starts_the_original",
        || {
            let f = Fixture::new();
            let source = source_id();
            let before = temporary_name(&f.operation, "before-front");
            observe(&f, &source, named(f.source.clone(), &before));
            journal(
                &f,
                &[
                    "stop-attempt",
                    "old-rename-attempt",
                    "old-renamed",
                    "new-rename-attempt",
                ],
            );
            f.port.effect(
                rename(&source, "fixture"),
                vec![(source.as_str(), f.source.clone())],
            );
            f.port.effect(
                start(&source),
                vec![(source.as_str(), running(f.source.clone()))],
            );
            f.ready_source();
            let error = restore(&f, DeploymentError::new("DEPLOYMENT_ENGINE_REFUSED"));
            assert_eq!(error.code(), "DEPLOYMENT_ENGINE_REFUSED");
            assert!(matches!(
                error.source_restore(),
                Some(SourceRestore::Restored)
            ));
            assert_eq!(
                f.port.posts(),
                vec![rename(&source, "fixture"), start(&source)]
            );
            assert_eq!(status(&f).stage, "RESTORED");
            f.close_adoption();
        },
    );
}

#[test]
fn a_refused_candidate_start_swaps_the_names_back_and_starts_the_original() {
    namespace(
        "a_refused_candidate_start_swaps_the_names_back_and_starts_the_original",
        || {
            let f = Fixture::new();
            let (source, new) = (source_id(), candidate_id());
            let created = candidate(&f);
            let before = temporary_name(&f.operation, "before-front");
            let failed = temporary_name(&f.operation, "failed-front");
            observe(&f, &source, named(f.source.clone(), &before));
            observe(&f, &new, named(created.clone(), "fixture"));
            journal(
                &f,
                &[
                    "stop-attempt",
                    "old-rename-attempt",
                    "old-renamed",
                    "new-rename-attempt",
                    "new-renamed",
                    "start-attempt",
                ],
            );
            f.port.effect(
                rename(&new, &failed),
                vec![(new.as_str(), named(created, &failed))],
            );
            f.port.effect(
                rename(&source, "fixture"),
                vec![(source.as_str(), f.source.clone())],
            );
            f.port.effect(
                start(&source),
                vec![(source.as_str(), running(f.source.clone()))],
            );
            f.ready_source();
            let error = restore(&f, DeploymentError::new("DEPLOYMENT_ENGINE_REFUSED"));
            assert!(matches!(
                error.source_restore(),
                Some(SourceRestore::Restored)
            ));
            assert_eq!(
                f.port.posts(),
                vec![
                    rename(&new, &failed),
                    rename(&source, "fixture"),
                    start(&source)
                ]
            );
            assert_eq!(status(&f).stage, "RESTORED");
            f.close_adoption();
        },
    );
}

#[test]
fn a_candidate_that_has_run_is_never_replaced_automatically() {
    namespace(
        "a_candidate_that_has_run_is_never_replaced_automatically",
        || {
            let f = Fixture::new();
            let new = candidate_id();
            let mut exited = named(candidate(&f), "fixture");
            exited["State"]["Status"] = json!("exited");
            observe(&f, &new, exited);
            journal(
                &f,
                &[
                    "stop-attempt",
                    "old-rename-attempt",
                    "new-rename-attempt",
                    "start-attempt",
                ],
            );
            let error = restore(&f, DeploymentError::new("DEPLOYMENT_WEBSITE_EXITED"));
            assert_eq!(error.code(), "DEPLOYMENT_WEBSITE_EXITED");
            assert!(matches!(
                error.source_restore(),
                Some(SourceRestore::NotAttempted(_))
            ));
            assert_eq!(restore_code(&error), Some(CANDIDATE_STARTED));
            assert!(f.port.posts().is_empty());
            assert!(!f.operation.exists("rollback-attempt"));
            let status = status(&f);
            assert_eq!(status.stage, "START_UNCONFIRMED");
            let decision = status.automatic_restore.unwrap();
            assert_eq!(decision["decision"], "REFUSED");
            assert_eq!(decision["outcome"], "NOT_ATTEMPTED");
            assert_eq!(decision["refusal"]["error"]["code"], CANDIDATE_STARTED);
            f.close();
        },
    );
}

#[test]
fn a_lost_engine_response_issues_no_further_request() {
    namespace("a_lost_engine_response_issues_no_further_request", || {
        let f = Fixture::new();
        journal(&f, &["stop-attempt"]);
        let lost = DeploymentError::new("DEPLOYMENT_SOURCE_STATE_CHANGED")
            .with_finalizer(DeploymentError::new("DEPLOYMENT_ENGINE_RESPONSE_UNKNOWN"));
        for failure in [
            DeploymentError::new("DEPLOYMENT_ENGINE_RESPONSE_UNKNOWN"),
            lost,
        ] {
            let error = restore(&f, failure);
            assert!(matches!(
                error.source_restore(),
                Some(SourceRestore::NotAttempted(_))
            ));
            assert_eq!(restore_code(&error), Some(OUTCOME_UNKNOWN));
        }
        assert!(f.port.calls().is_empty());
        assert!(!f.operation.exists("rollback-attempt"));
        assert_eq!(status(&f).stage, "STOP_UNCONFIRMED");
        f.close();
    });
}

#[test]
fn a_changed_bind_refuses_before_the_one_rollback_attempt_is_used() {
    namespace(
        "a_changed_bind_refuses_before_the_one_rollback_attempt_is_used",
        || {
            use std::os::unix::fs::PermissionsExt;
            let f = Fixture::new();
            journal(&f, &["stop-attempt"]);
            let pins = f.service.pins(&f.operation).unwrap();
            let path = Path::new("/tmp/deployment/data");
            let original = std::fs::metadata(path).unwrap().permissions();
            std::fs::set_permissions(
                path,
                std::fs::Permissions::from_mode(original.mode() ^ 0o010),
            )
            .unwrap();
            let result = f.service.restoring_source(
                &f.operation,
                &pins,
                false,
                Err::<(), _>(rehearsal_refused()),
            );
            std::fs::set_permissions(path, original).unwrap();
            pins.close().unwrap();
            let error = result.unwrap_err();
            assert!(matches!(
                error.source_restore(),
                Some(SourceRestore::NotAttempted(_))
            ));
            assert_eq!(restore_code(&error), Some("DEPLOYMENT_BIND_CHANGED"));
            assert!(f.port.posts().is_empty());
            assert!(!f.operation.exists("rollback-attempt"));
            assert_eq!(
                status(&f).automatic_restore.unwrap()["outcome"],
                "NOT_ATTEMPTED"
            );
            f.close();
        },
    );
}

#[test]
fn an_unproven_restore_is_closed_later_by_observation_without_any_effect() {
    namespace(
        "an_unproven_restore_is_closed_later_by_observation_without_any_effect",
        || {
            let f = Fixture::new();
            let source = source_id();
            let operation = f.operation.plan.operation.clone();
            journal(&f, &["stop-attempt"]);
            // The controlled Engine refuses the start of the original console.
            let error = restore(&f, rehearsal_refused());
            assert_eq!(error.code(), "DEPLOYMENT_RESTORE_REHEARSAL_REFUSED");
            assert!(matches!(
                error.source_restore(),
                Some(SourceRestore::Unproven(_))
            ));
            assert_eq!(restore_code(&error), Some("DEPLOYMENT_ENGINE_REFUSED"));
            assert_eq!(f.port.posts(), vec![start(&source)]);
            let unproven = status(&f);
            assert_eq!(unproven.stage, "ROLLBACK_UNCONFIRMED");
            assert_eq!(unproven.automatic_restore.unwrap()["outcome"], "UNPROVEN");
            f.port.clear();
            // Still stopped: the used attempt is not repeated.
            assert_eq!(
                f.service.rollback(&operation).err().unwrap().code(),
                "DEPLOYMENT_ROLLBACK_ALREADY_ATTEMPTED"
            );
            assert!(!f.operation.exists("restored"));
            // Once the original console is observed running and ready, the
            // same command records that and issues nothing.
            observe(&f, &source, running(f.source.clone()));
            f.ready_source();
            assert_eq!(f.service.rollback(&operation).unwrap().stage, "RESTORED");
            assert!(f.port.posts().is_empty());
            assert_eq!(status(&f).automatic_restore.unwrap()["outcome"], "RESTORED");
            assert_eq!(
                f.service.rollback(&operation).err().unwrap().code(),
                "DEPLOYMENT_ROLLBACK_ALREADY_ATTEMPTED"
            );
            f.close_adoption();
        },
    );
}

#[test]
fn only_the_call_that_journaled_the_stop_restores_and_success_is_untouched() {
    namespace(
        "only_the_call_that_journaled_the_stop_restores_and_success_is_untouched",
        || {
            let f = Fixture::new();
            journal(&f, &["stop-attempt"]);
            let pins = f.service.pins(&f.operation).unwrap();
            let earlier = f
                .service
                .restoring_source(&f.operation, &pins, true, Err::<(), _>(rehearsal_refused()))
                .unwrap_err();
            assert!(earlier.source_restore().is_none());
            assert_eq!(
                f.service
                    .restoring_source(&f.operation, &pins, false, Ok(7))
                    .unwrap(),
                7
            );
            pins.close().unwrap();
            assert!(f.port.calls().is_empty());
            assert!(!f.operation.exists("automatic-restore"));
            assert!(status(&f).automatic_restore.is_none());
            f.close();
        },
    );
}

#[test]
fn a_failure_before_the_stop_restores_nothing() {
    namespace("a_failure_before_the_stop_restores_nothing", || {
        let f = Fixture::new();
        let error = restore(&f, DeploymentError::new("DEPLOYMENT_CANDIDATE_CHANGED"));
        assert!(error.source_restore().is_none());
        assert!(f.port.calls().is_empty());
        assert!(!f.operation.exists("automatic-restore"));
        f.close();
    });
}

#[test]
fn apply_restarts_the_office_when_the_first_rename_is_refused_after_the_stop() {
    namespace(
        "apply_restarts_the_office_when_the_first_rename_is_refused_after_the_stop",
        || {
            let f = Fixture::live_accounts();
            let source = source_id();
            let before = temporary_name(&f.operation, "before-front");
            f.port.effect(
                stop(&source),
                vec![(source.as_str(), stopped(f.source.clone()))],
            );
            f.port.effect(
                start(&source),
                vec![(source.as_str(), running(f.source.clone()))],
            );
            f.ready_source();
            let error = f
                .service
                .apply_live_without_backup(&f.operation.plan.operation)
                .err()
                .unwrap();
            assert_eq!(error.code(), "DEPLOYMENT_ENGINE_REFUSED");
            assert!(matches!(
                error.source_restore(),
                Some(SourceRestore::Restored)
            ));
            assert_eq!(
                f.port.posts(),
                vec![stop(&source), rename(&source, &before), start(&source)]
            );
            assert_eq!(status(&f).stage, "RESTORED");
            f.close_adoption();
        },
    );
}

#[test]
fn apply_returns_to_the_original_office_when_the_new_console_cannot_start() {
    namespace(
        "apply_returns_to_the_original_office_when_the_new_console_cannot_start",
        || {
            let f = Fixture::live_accounts();
            let (source, new) = (source_id(), candidate_id());
            let created = candidate(&f);
            let before = temporary_name(&f.operation, "before-front");
            let failed = temporary_name(&f.operation, "failed-front");
            let down = stopped(f.source.clone());
            f.port
                .effect(stop(&source), vec![(source.as_str(), down.clone())]);
            f.port.effect(
                rename(&source, &before),
                vec![(source.as_str(), named(down.clone(), &before))],
            );
            f.port.effect(
                rename(&new, "fixture"),
                vec![(new.as_str(), named(created.clone(), "fixture"))],
            );
            f.port.effect(
                rename(&new, &failed),
                vec![(new.as_str(), named(created, &failed))],
            );
            f.port
                .effect(rename(&source, "fixture"), vec![(source.as_str(), down)]);
            f.port.effect(
                start(&source),
                vec![(source.as_str(), running(f.source.clone()))],
            );
            f.ready_source();
            let error = f
                .service
                .apply_live_without_backup(&f.operation.plan.operation)
                .err()
                .unwrap();
            assert_eq!(error.code(), "DEPLOYMENT_ENGINE_REFUSED");
            assert!(matches!(
                error.source_restore(),
                Some(SourceRestore::Restored)
            ));
            assert_eq!(
                f.port.posts(),
                vec![
                    stop(&source),
                    rename(&source, &before),
                    rename(&new, "fixture"),
                    start(&new),
                    rename(&new, &failed),
                    rename(&source, "fixture"),
                    start(&source),
                ]
            );
            assert!(!f.operation.exists("started"));
            assert_eq!(status(&f).stage, "RESTORED");
            f.close_adoption();
        },
    );
}

#[test]
fn apply_leaves_a_new_console_that_ran_and_exited_for_the_owner() {
    namespace(
        "apply_leaves_a_new_console_that_ran_and_exited_for_the_owner",
        || {
            let f = Fixture::live_accounts();
            let (source, new) = (source_id(), candidate_id());
            let created = named(candidate(&f), "fixture");
            let before = temporary_name(&f.operation, "before-front");
            let down = stopped(f.source.clone());
            let mut exited = created.clone();
            exited["State"]["Status"] = json!("exited");
            f.port
                .effect(stop(&source), vec![(source.as_str(), down.clone())]);
            f.port.effect(
                rename(&source, &before),
                vec![(source.as_str(), named(down, &before))],
            );
            f.port
                .effect(rename(&new, "fixture"), vec![(new.as_str(), created)]);
            f.port.effect(start(&new), vec![(new.as_str(), exited)]);
            let error = f
                .service
                .apply_live_without_backup(&f.operation.plan.operation)
                .err()
                .unwrap();
            assert_eq!(error.code(), "DEPLOYMENT_WEBSITE_EXITED");
            assert_eq!(restore_code(&error), Some(CANDIDATE_STARTED));
            assert_eq!(
                f.port.posts(),
                vec![
                    stop(&source),
                    rename(&source, &before),
                    rename(&new, "fixture"),
                    start(&new),
                ]
            );
            assert!(!f.operation.exists("rollback-attempt"));
            assert_eq!(status(&f).stage, "START_UNCONFIRMED");
            f.close();
        },
    );
}
