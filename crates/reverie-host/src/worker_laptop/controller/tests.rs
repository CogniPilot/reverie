//! Same real Created/storage/Office owners with controlled Engine child
//! observations. These tests mint no ActivatedController or installed pool.
use super::*;
use crate::{
    command_telemetry::CommandTelemetry, worker_laptop::tests::Fixture,
    worker_pool::controlled_member_refusal, worker_storage::StorageLease,
};
use reverie_core::ids::ProfileSessionId;
use std::{fs, time::Duration};

const SID: &str = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
fn end() -> Instant {
    Instant::now() + Duration::from_secs(5)
}
fn isolated(name: &str) -> bool {
    crate::test_process::isolate_case(&format!("worker_laptop::controller::tests::{name}"))
}

fn started(fixture: &Fixture) -> (CreatedLaptop, StartedContainer) {
    let (nix, plan, request, phone) = fixture.resources_with_effective(
        &ProfileSessionId::parse(SID).unwrap(),
        fixture.source.clone(),
    );
    let runtime = fixture.runtime();
    let workflow = runtime
        .retain_laptop_network(&nix, plan, request, phone)
        .unwrap_or_else(|_| panic!("owned retain"));
    runtime.run_laptop_network(&workflow, end()).unwrap();
    let telemetry = CommandTelemetry::capture(runtime, &fixture.source).unwrap();
    let LaptopCreation::Created(created) =
        runtime.create_laptop(&workflow, &telemetry, end()).unwrap()
    else {
        panic!("actual controlled create reply");
    };
    runtime.publish_laptop_launch(&created).unwrap();
    let ContainerStart::Started(started) = runtime.start_laptop_container(&created, end()).unwrap()
    else {
        panic!("actual controlled start reply");
    };
    (created, started)
}

fn refusal(record: &Record, attempt: &MemberConfigurationAttempt) -> PoolError {
    let target = CreatedPoolTarget {
        employee: record
            .resources()
            .plan
            .storage()
            .employee()
            .unwrap()
            .clone(),
        container: record
            .creation
            .as_ref()
            .unwrap()
            .container
            .as_ref()
            .unwrap()
            .clone(),
        record,
        attempt: attempt.clone(),
    };
    controlled_member_refusal(Some(&target))
}

fn reject(created: &CreatedLaptop) -> PoolError {
    let mut record = created.workflow.record.lock().unwrap();
    assert!(record.phase == Phase::Known && !record.unknown && record.pending.is_none());
    let attempt = record.begin_controller_member_attempt();
    let error = refusal(&record, &attempt);
    let error = record.reject_controller_member(&attempt, error);
    assert!(record.phase == Phase::MemberRefused && !record.unknown);
    assert!(
        record
            .creation
            .as_ref()
            .unwrap()
            .controller_member_attempt
            .is_some()
    );
    error
}

fn trace(fixture: &Fixture) -> Vec<u8> {
    fs::read(fixture.root.join("trace")).unwrap()
}

fn assert_forward_denied(fixture: &Fixture, created: &CreatedLaptop, started: &StartedContainer) {
    let runtime = fixture.runtime();
    let workflow = &created.workflow;
    let before = trace(fixture);
    let telemetry = CommandTelemetry::capture(runtime, &fixture.source).unwrap();
    assert!(runtime.run_laptop_network(workflow, end()).is_err());
    assert!(runtime.create_laptop(workflow, &telemetry, end()).is_err());
    assert!(runtime.publish_laptop_launch(created).is_err());
    assert!(runtime.start_laptop_container(created, end()).is_err());
    assert!(
        runtime
            .configure_started_laptop_memory(started, end())
            .is_err()
    );
    assert!(runtime.laptop_workflows().settle(runtime, end()).is_err());
    assert!(created.workflow.record.lock().unwrap().phase == Phase::MemberRefused);
    assert_eq!(
        trace(fixture),
        before,
        "no forward or settlement command may dispatch"
    );
}

#[test]
fn known_exact_refusal_is_cleanup_only_until_actual_stop_and_all_owners_close() {
    if isolated("known_exact_refusal_is_cleanup_only_until_actual_stop_and_all_owners_close") {
        return;
    }
    let fixture = Fixture::employee("created-normal");
    let runtime = fixture.runtime();
    let (created, started) = started(&fixture);
    let error = reject(&created);
    assert_eq!(error.code(), "WORKER_POOL_MEMBER_CAPACITY_EXHAUSTED");
    assert_forward_denied(&fixture, &created, &started);
    let session = ProfileSessionId::parse(SID).unwrap();
    assert!(StorageLease::acquire_migration(&fixture.source, &session).is_err());
    assert!(
        runtime
            .reclaim_laptop_network(created.workflow.clone())
            .is_err()
    );
    let CreatedCleanup::Stopped(stopped) = runtime.stop_created_laptop(&created, end()).unwrap()
    else {
        panic!("exact controlled CID stop/readback");
    };
    runtime
        .close_created_laptop_viewer(&created, end())
        .unwrap();
    runtime
        .cleanup_created_laptop_nix_guard(&created, end())
        .unwrap();
    runtime.cleanup_created_laptop_request(&created).unwrap();
    fs::write(fixture.root.join("created-final-inspect.json"), serde_json::to_vec(&serde_json::json!([{
        "Id":"c".repeat(64),"Name":format!("/fixture-agent-{SID}"),
        "Config":{"Labels":{"reverie.worker":"fixture","reverie.session":SID}},"State":{"Running":false}
    }])).unwrap()).unwrap();
    let observation = runtime.observe_created_final_storage(&created).unwrap();
    assert!(!observation.is_live());
    assert!(
        runtime
            .prepare_stopped_created_return(&stopped, &observation)
            .is_err(),
        "Office still owns resources"
    );
    {
        let record = created.workflow.record.lock().unwrap();
        fixture
            .office
            .close_phone(&record.resources().office, end())
            .unwrap();
    }
    let returned = runtime
        .prepare_stopped_created_return(&stopped, &observation)
        .unwrap();
    let (storage, _, _, _, failure) = returned.into_parts();
    assert_eq!(
        failure.unwrap().code(),
        "WORKER_POOL_MEMBER_CAPACITY_EXHAUSTED"
    );
    assert!(StorageLease::acquire_migration(&fixture.source, &session).is_err());
    storage.close(end()).unwrap();
    StorageLease::acquire_migration(&fixture.source, &session)
        .unwrap()
        .close()
        .unwrap();
    runtime.close(end()).unwrap();
}

#[test]
fn known_refusal_with_uncertain_stop_or_native_close_retains_original_resources() {
    if isolated("known_refusal_with_uncertain_stop_or_native_close_retains_original_resources") {
        return;
    }
    for mode in [
        "created-stop-bad-utf8",
        "created-inspect-mismatch",
        "checked-close",
    ] {
        let hooks = crate::captured_client::test_hooks::Hooks::default();
        let fixture = Fixture::employee_with_hooks(
            if mode == "checked-close" {
                "created-normal"
            } else {
                mode
            },
            hooks.clone(),
        );
        let (created, _) = started(&fixture);
        reject(&created);
        if mode == "checked-close" {
            hooks
                .close_failed
                .store(true, std::sync::atomic::Ordering::Release);
        }
        assert!(matches!(
            fixture
                .runtime()
                .stop_created_laptop(&created, end())
                .unwrap(),
            CreatedCleanup::Retained
        ));
        assert!(matches!(
            fixture
                .runtime()
                .stop_created_laptop(&created, end())
                .unwrap(),
            CreatedCleanup::Retained
        ));
        assert!(
            StorageLease::acquire_migration(
                &fixture.source,
                &ProfileSessionId::parse(SID).unwrap()
            )
            .is_err()
        );
        assert!(
            fixture
                .runtime()
                .reclaim_laptop_network(created.workflow.clone())
                .is_err()
        );
    }
}

#[test]
fn foreign_unbound_lookalike_and_prior_unknown_cannot_mint_cleanup_only_state() {
    if isolated("foreign_unbound_lookalike_and_prior_unknown_cannot_mint_cleanup_only_state") {
        return;
    }
    for case in ["foreign", "unbound", "lookalike", "prior-unknown"] {
        let fixture = Fixture::employee("created-normal");
        let (created, _) = started(&fixture);
        let mut record = created.workflow.record.lock().unwrap();
        let attempt = record.begin_controller_member_attempt();
        let error = match case {
            "foreign" => refusal(&record, &MemberConfigurationAttempt::new()),
            "unbound" => controlled_member_refusal(None),
            "lookalike" => PoolError::Refused("WORKER_POOL_MEMBER_CAPACITY_EXHAUSTED"),
            "prior-unknown" => {
                record.unknown = true;
                refusal(&record, &attempt)
            }
            _ => unreachable!(),
        };
        let rejected = record.reject_controller_member(&attempt, error);
        assert!(
            !matches!(rejected, PoolError::MemberRequestRefused(_)),
            "{case}"
        );
        assert!(record.phase == Phase::Retained && record.unknown, "{case}");
    }
}
