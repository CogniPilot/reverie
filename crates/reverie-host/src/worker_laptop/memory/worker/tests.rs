//! Same actual accepted J/resource chain with explicitly synthetic owned kernel
//! files. These controls do not qualify a live cgroup or installed App caller.
use super::*;
use crate::{
    command_telemetry::CommandTelemetry,
    worker_laptop::tests::Fixture,
    worker_reports::{WorkerLaunchHold, WorkerReportService},
};
use reverie_contracts::{resource_config::ResourceIdentitySettings, worker_config};
use serde_json::json;
use std::{cell::Cell, fs, os::unix::net::UnixStream};
mod fixture;
use fixture::{Context, Facts};
fn isolated(name: &str) -> bool {
    crate::test_process::isolate_case(&format!("worker_laptop::memory::worker::tests::{name}"))
}
#[test]
fn actual_source_selection_is_lazy_and_enabled_source_cannot_skip_it() {
    if isolated("actual_source_selection_is_lazy_and_enabled_source_cannot_skip_it") {
        return;
    }
    let context = Context::without_memory_policy();
    let facts = Facts::new();
    let runtime = context.fixture.runtime();
    assert!(matches!(
        runtime
            .laptop_workflows()
            .begin_worker_memory(runtime, &context.started, &context.connection, None, &facts)
            .unwrap(),
        WorkerMemoryBegin::Configured(_)
    ));
    assert_eq!((facts.hosts.get(), facts.targets.get()), (0, 0));
    context.finish();
    let context = Context::new();
    let runtime = context.fixture.runtime();
    assert!(matches!(
        runtime
            .laptop_workflows()
            .begin_worker_memory(runtime, &context.started, &context.connection, None, &facts)
            .unwrap(),
        WorkerMemoryBegin::Rejected
    ));
    assert_eq!((facts.hosts.get(), facts.targets.get()), (0, 0));
    context.finish();
}
#[test]
fn actual_global_settlement_closes_abandoned_outer_without_acknowledging_write() {
    if isolated("actual_global_settlement_closes_abandoned_outer_without_acknowledging_write") {
        return;
    }
    let context = Context::new();
    let facts = Facts::new();
    let runtime = context.fixture.runtime();
    let WorkerMemoryBegin::Policy(policy) = runtime
        .laptop_workflows()
        .begin_worker_memory(
            runtime,
            &context.started,
            &context.connection,
            Some(&context.effective),
            &facts,
        )
        .unwrap()
    else {
        panic!("actual policy");
    };
    let WorkerMemoryEffect::Readback(readback) = runtime
        .laptop_workflows()
        .apply_worker_memory(
            runtime,
            &policy,
            &context.connection,
            &worker_config::policy_digest(&context.effective),
            &facts,
        )
        .unwrap()
    else {
        panic!("actual readback");
    };
    assert_eq!(facts.held(), 1);
    runtime.request_stop();
    assert!(runtime.settle_owned(fixture::end()).is_err());
    assert_eq!(facts.held(), 0);
    assert!(
        context
            .workflow
            .failure()
            .unwrap()
            .unwrap()
            .unconfirmed_native()
    );
    assert!(
        runtime
            .reject_started_laptop_memory_readback_for_connection(&readback, &context.connection)
            .is_err()
    );
    context.finish();
}
#[test]
fn actual_worker_joins_keep_distinct_inner_and_outer_targets_until_fresh_readback() {
    if isolated("actual_worker_joins_keep_distinct_inner_and_outer_targets_until_fresh_readback") {
        return;
    }
    let context = Context::new();
    let facts = Facts::new();
    let runtime = context.fixture.runtime();
    let WorkerMemoryBegin::Policy(policy) = runtime
        .laptop_workflows()
        .begin_worker_memory(
            runtime,
            &context.started,
            &context.connection,
            Some(&context.effective),
            &facts,
        )
        .unwrap()
    else {
        panic!("actual policy phase");
    };
    assert_eq!(facts.targets.get(), 0);
    let WorkerMemoryEffect::Readback(readback) = runtime
        .laptop_workflows()
        .apply_worker_memory(
            runtime,
            &policy,
            &context.connection,
            &worker_config::policy_digest(&context.effective),
            &facts,
        )
        .unwrap()
    else {
        panic!(
            "actual high/readback phase: {:?}",
            context.workflow.failure().unwrap()
        );
    };
    assert_eq!(
        facts.targets.get(),
        2,
        "outer capture then separate A.apply_high target"
    );
    assert_eq!(
        facts.held(),
        1,
        "inner closed; actual outer remains through App policy reads"
    );
    assert_eq!(
        fs::read_to_string(facts.root().join("cgroup/laptop/memory.high")).unwrap(),
        "1073741824\n"
    );
    assert!(matches!(
        runtime
            .laptop_workflows()
            .finish_worker_memory(
                runtime,
                &readback,
                &context.connection,
                &context.effective,
                Some(&worker_config::policy_digest(&context.effective)),
                &facts
            )
            .unwrap(),
        MemoryConfiguration::Configured(_)
    ));
    assert_eq!(
        facts.held(),
        0,
        "outer checked close follows final readback"
    );
    assert!(
        runtime
            .laptop_workflows()
            .finish_worker_memory(
                runtime,
                &readback,
                &context.connection,
                &context.effective,
                Some(&worker_config::policy_digest(&context.effective)),
                &facts
            )
            .is_err()
    );
    context.finish();
}
#[test]
fn wrong_actual_j_and_late_policy_failure_do_not_write_or_replay() {
    if isolated("wrong_actual_j_and_late_policy_failure_do_not_write_or_replay") {
        return;
    }
    let context = Context::new();
    let facts = Facts::new();
    let runtime = context.fixture.runtime();
    let (_client, foreign, mut hold) = context
        .fixture
        .accepted(&context.service, "second-same-SID");
    assert!(
        runtime
            .laptop_workflows()
            .begin_worker_memory(
                runtime,
                &context.started,
                &foreign,
                Some(&context.effective),
                &facts
            )
            .is_err()
    );
    assert_eq!(facts.targets.get(), 0);
    assert_eq!(facts.hosts.get(), 0);
    let WorkerMemoryBegin::Policy(policy) = runtime
        .laptop_workflows()
        .begin_worker_memory(
            runtime,
            &context.started,
            &context.connection,
            Some(&context.effective),
            &facts,
        )
        .unwrap()
    else {
        panic!("real phase");
    };
    let other = worker_config::decode(br#"{"changed":true}"#).unwrap();
    assert!(matches!(
        runtime
            .laptop_workflows()
            .apply_worker_memory(
                runtime,
                &policy,
                &context.connection,
                &worker_config::policy_digest(&other),
                &facts
            )
            .unwrap(),
        WorkerMemoryEffect::Rejected
    ));
    assert_eq!(
        facts.targets.get(),
        0,
        "late digest checked before either target constructor"
    );
    assert!(
        runtime
            .laptop_workflows()
            .apply_worker_memory(
                runtime,
                &policy,
                &context.connection,
                &worker_config::policy_digest(&context.effective),
                &facts
            )
            .is_err()
    );
    foreign.close_socket(fixture::end()).unwrap();
    hold.release(fixture::end()).unwrap();
    context.finish();
}
#[test]
fn stopped_and_closed_j_still_checked_closes_actual_outer_and_latches_attempted_write() {
    if isolated(
        "stopped_and_closed_j_still_checked_closes_actual_outer_and_latches_attempted_write",
    ) {
        return;
    }
    let context = Context::new();
    let facts = Facts::new();
    let runtime = context.fixture.runtime();
    let WorkerMemoryBegin::Policy(policy) = runtime
        .laptop_workflows()
        .begin_worker_memory(
            runtime,
            &context.started,
            &context.connection,
            Some(&context.effective),
            &facts,
        )
        .unwrap()
    else {
        panic!("real phase");
    };
    let WorkerMemoryEffect::Readback(readback) = runtime
        .laptop_workflows()
        .apply_worker_memory(
            runtime,
            &policy,
            &context.connection,
            &worker_config::policy_digest(&context.effective),
            &facts,
        )
        .unwrap()
    else {
        panic!("real effect");
    };
    assert_eq!(facts.held(), 1);
    runtime.request_stop();
    context.connection.close_socket(fixture::end()).unwrap();
    assert!(matches!(
        runtime
            .reject_started_laptop_memory_readback_for_connection(&readback, &context.connection)
            .unwrap(),
        MemoryConfiguration::Retained
    ));
    assert_eq!(facts.held(), 0);
    assert!(
        context
            .workflow
            .failure()
            .unwrap()
            .unwrap()
            .unconfirmed_native()
    );
    assert!(
        runtime
            .reject_started_laptop_memory_readback_for_connection(&readback, &context.connection)
            .is_err()
    );
    context.finish();
}
