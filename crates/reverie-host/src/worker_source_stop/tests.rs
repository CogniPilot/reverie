//! Actual same-runtime/lease and controlled-source process observations. Engine
//! replies/effects are an owned Rust fixture, not live-container authority.
use super::*;
mod fixture;
use fixture::{Fixture, OTHER, SID, end};
use reverie_contracts::worker_config;
fn isolated(name: &str) -> bool {
    crate::test_process::isolate_case(name)
}

#[test]
fn selected_sid_mismatch_returns_same_held_lease_without_native_dispatch() {
    if isolated(
        "worker_source_stop::tests::selected_sid_mismatch_returns_same_held_lease_without_native_dispatch",
    ) {
        return;
    }
    let fixture = Fixture::new("never");
    let original = fixture.storage();
    let expected = original.paths().clone();
    let failure = fixture
        .runtime
        .retain_original_source_stop(
            original,
            fixture.name(OTHER, &fixture.start),
            &fixture.config,
            Some(end()),
        )
        .err()
        .unwrap();
    let (original, error) = failure.into_parts();
    assert_eq!(error.code(), "WORKER_STORAGE_RUNTIME_BINDING_CHANGED");
    assert_eq!(original.paths(), &expected);
    fixture.assert_held();
    assert!(fixture.trace().is_empty());
    original.close(end()).unwrap();
}

#[test]
fn actual_stop_reaps_owned_target_and_closes_original_resource_once() {
    if isolated(
        "worker_source_stop::tests::actual_stop_reaps_owned_target_and_closes_original_resource_once",
    ) {
        return;
    }
    let fixture = Fixture::new("stop-requested");
    let mut owner = fixture.owner();
    owner.inspect(&fixture.runtime).unwrap();
    owner
        .stop_after_policy(
            &fixture.runtime,
            &worker_config::policy_digest(&fixture.config),
        )
        .unwrap();
    assert!(fixture.root.join("source-reaped").exists());
    fixture.assert_held();
    assert!(owner.inspect(&fixture.runtime).is_err());
    assert!(
        owner
            .stop_after_policy(
                &fixture.runtime,
                &worker_config::policy_digest(&fixture.config)
            )
            .is_err()
    );
    owner
        .close_stopped_resource(&fixture.runtime, end())
        .unwrap();
    assert!(
        owner
            .close_stopped_resource(&fixture.runtime, end())
            .is_err()
    );
    let trace = fixture.trace();
    assert_eq!(trace.len(), 3);
    assert!(trace[0].starts_with("inspect\0test-agent-"));
    assert!(trace[1].starts_with(&format!("stop\0--time\0{}\0", 2)));
    assert!(trace[2].starts_with("inspect\0"));
}

#[test]
fn running_after_stop_gets_same_process_check_then_exact_cid_kill() {
    if isolated(
        "worker_source_stop::tests::running_after_stop_gets_same_process_check_then_exact_cid_kill",
    ) {
        return;
    }
    let fixture = Fixture::new("kill-requested");
    fixture.write_rows("after.json", &fixture.row);
    let mut owner = fixture.owner();
    owner.inspect(&fixture.runtime).unwrap();
    owner
        .stop_after_policy(
            &fixture.runtime,
            &worker_config::policy_digest(&fixture.config),
        )
        .unwrap();
    let trace = fixture.trace();
    assert_eq!(trace.len(), 5);
    assert!(trace[3].starts_with("kill\0"));
    assert!(fixture.root.join("source-reaped").exists());
    fixture.assert_held();
    owner
        .close_stopped_resource(&fixture.runtime, end())
        .unwrap();
}

#[test]
fn failed_original_start_validation_never_dispatches_stop_or_releases_lease() {
    if isolated(
        "worker_source_stop::tests::failed_original_start_validation_never_dispatches_stop_or_releases_lease",
    ) {
        return;
    }
    let fixture = Fixture::new("never");
    let mut owner = fixture
        .runtime
        .retain_original_source_stop(
            fixture.storage(),
            fixture.name(SID, "0"),
            &fixture.config,
            Some(end()),
        )
        .unwrap_or_else(|_| panic!("actual resource retained"));
    owner.inspect(&fixture.runtime).unwrap();
    assert!(
        owner
            .stop_after_policy(
                &fixture.runtime,
                &worker_config::policy_digest(&fixture.config)
            )
            .is_err()
    );
    owner.settle_native(&fixture.runtime, end()).unwrap();
    assert!(
        owner
            .close_stopped_resource(&fixture.runtime, end())
            .is_err()
    );
    fixture.assert_held();
    assert_eq!(fixture.trace().len(), 1);
}

#[test]
fn late_policy_refusal_is_terminal_without_native_stop_or_resource_release() {
    if isolated(
        "worker_source_stop::tests::late_policy_refusal_is_terminal_without_native_stop_or_resource_release",
    ) {
        return;
    }
    let fixture = Fixture::new("never");
    let mut owner = fixture.owner();
    owner.inspect(&fixture.runtime).unwrap();
    owner.refuse_policy(&fixture.runtime).unwrap();
    assert!(owner.inspect(&fixture.runtime).is_err());
    assert!(
        owner
            .stop_after_policy(
                &fixture.runtime,
                &worker_config::policy_digest(&fixture.config)
            )
            .is_err()
    );
    owner.settle_native(&fixture.runtime, end()).unwrap();
    assert!(
        owner
            .close_stopped_resource(&fixture.runtime, end())
            .is_err()
    );
    fixture.assert_held();
    assert_eq!(fixture.trace().len(), 1);
}

#[test]
fn policy_mismatch_retains_original_process_and_lease_without_stop() {
    if isolated(
        "worker_source_stop::tests::policy_mismatch_retains_original_process_and_lease_without_stop",
    ) {
        return;
    }
    let fixture = Fixture::new("never");
    let mut changed = fixture.row.clone();
    changed["Config"]["Labels"]["reverie.worker-policy"] = serde_json::json!("f".repeat(64));
    fixture.write_rows("before.json", &changed);
    let mut owner = fixture.owner();
    owner.inspect(&fixture.runtime).unwrap();
    assert!(
        owner
            .stop_after_policy(
                &fixture.runtime,
                &worker_config::policy_digest(&fixture.config)
            )
            .is_err()
    );
    owner.settle_native(&fixture.runtime, end()).unwrap();
    assert!(
        owner
            .close_stopped_resource(&fixture.runtime, end())
            .is_err()
    );
    fixture.assert_held();
    assert_eq!(fixture.trace().len(), 1);
}

#[test]
fn changed_metadata_after_real_stop_does_not_release_original_lease() {
    if isolated(
        "worker_source_stop::tests::changed_metadata_after_real_stop_does_not_release_original_lease",
    ) {
        return;
    }
    let fixture = Fixture::new("stop-requested");
    let mut changed = fixture.row.clone();
    changed["State"] = serde_json::json!({"Running":false,"Pid":0});
    changed["Image"] = serde_json::json!(format!("sha256:{}", "b".repeat(64)));
    assert_ne!(changed["Image"], fixture.row["Image"]);
    fixture.write_rows("after.json", &changed);
    let mut owner = fixture.owner();
    owner.inspect(&fixture.runtime).unwrap();
    assert!(
        owner
            .stop_after_policy(
                &fixture.runtime,
                &worker_config::policy_digest(&fixture.config)
            )
            .is_err()
    );
    assert!(fixture.root.join("source-reaped").exists());
    owner.settle_native(&fixture.runtime, end()).unwrap();
    assert!(
        owner
            .close_stopped_resource(&fixture.runtime, end())
            .is_err()
    );
    fixture.assert_held();
    assert_eq!(fixture.trace().len(), 3);
}

#[test]
fn wrong_runtime_refusal_precedes_phase_change_and_keeps_original_owner_usable() {
    if isolated(
        "worker_source_stop::tests::wrong_runtime_refusal_precedes_phase_change_and_keeps_original_owner_usable",
    ) {
        return;
    }
    let fixture = Fixture::new("stop-requested");
    let foreign = Fixture::new("never");
    let mut owner = fixture.owner();
    assert_eq!(
        owner.inspect(&foreign.runtime).err().unwrap().code(),
        "RESOURCE_SOURCE_STOP_RUNTIME_CHANGED"
    );
    assert!(fixture.trace().is_empty() && foreign.trace().is_empty());
    owner.inspect(&fixture.runtime).unwrap();
    owner
        .stop_after_policy(
            &fixture.runtime,
            &worker_config::policy_digest(&fixture.config),
        )
        .unwrap();
    assert_eq!(
        owner
            .close_stopped_resource(&foreign.runtime, end())
            .err()
            .unwrap()
            .code(),
        "RESOURCE_SOURCE_STOP_RUNTIME_CHANGED"
    );
    fixture.assert_held();
    owner
        .close_stopped_resource(&fixture.runtime, end())
        .unwrap();
}
