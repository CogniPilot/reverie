use super::*;
struct Release(PathBuf);
impl Drop for Release {
    fn drop(&mut self) {
        fs::write(&self.0, b"owned release").unwrap();
    }
}
#[test]
fn foreign_runtime_and_other_actual_nix_record_cannot_consume_removal() {
    if isolated(
        "worker_source_stop::tests::legacy::removal::faults::foreign_runtime_and_other_actual_nix_record_cannot_consume_removal",
    ) {
        return;
    }
    let fixture = Fixture::new("stop-requested");
    let mut cold = prepare(&fixture, false);
    let other = Fixture::new("stop-requested");
    let other_cold = prepare(&other, false);
    assert!(
        other
            .runtime
            .remove_stopped_laptop_after_nix_for_worker(&cold.nix, &cold.plan, &mut cold.removal)
            .is_err()
    );
    assert!(
        fixture
            .runtime
            .remove_stopped_laptop_after_nix_for_worker(
                &other_cold.nix,
                &cold.plan,
                &mut cold.removal
            )
            .is_err()
    );
    assert_eq!(count(&fixture, "rm"), 0);
    assert_eq!(count(&other, "rm"), 0);
    let proof = fixture
        .runtime
        .remove_stopped_laptop_after_nix_for_worker(&cold.nix, &cold.plan, &mut cold.removal)
        .unwrap();
    assert!(
        proof
            .assert_workflow(&other.runtime, &other_cold.nix)
            .is_err()
    );
    reclaim(&fixture, cold);
    reclaim(&other, other_cold);
}
#[test]
fn post_nix_foreign_name_replacement_stays_alive_and_never_gets_rm() {
    if isolated(
        "worker_source_stop::tests::legacy::removal::faults::post_nix_foreign_name_replacement_stays_alive_and_never_gets_rm",
    ) {
        return;
    }
    let mut fixture = Fixture::new("stop-requested");
    let mut cold = prepare(&fixture, false);
    let mut foreign = Target::new(&fixture);
    let mut replaced = fixture.row.clone();
    replaced["Id"] = serde_json::json!("f".repeat(64));
    replaced["State"] = serde_json::json!({"Running":false,"Pid":0});
    fixture.write_rows("after.json", &replaced);
    assert!(
        fixture
            .runtime
            .remove_stopped_laptop_after_nix_for_worker(&cold.nix, &cold.plan, &mut cold.removal)
            .is_err()
    );
    assert_eq!(count(&fixture, "rm"), 0);
    assert!(foreign.child.try_wait().unwrap().is_none());
    settle_retained(&mut fixture, &mut cold);
}
#[test]
fn legacy_unknown_fields_are_not_exact_projection_but_exact_origin_stays_strict() {
    if isolated(
        "worker_source_stop::tests::legacy::removal::faults::legacy_unknown_fields_are_not_exact_projection_but_exact_origin_stays_strict",
    ) {
        return;
    }
    for exact in [false, true] {
        let mut fixture = Fixture::new("stop-requested");
        let mut cold = prepare(&fixture, exact);
        let mut changed = fixture.row.clone();
        changed["State"] = serde_json::json!({"Running":false,"Pid":0});
        changed["Image"] = serde_json::json!(format!("sha256:{}", "b".repeat(64)));
        fixture.write_rows("after.json", &changed);
        let result = fixture.runtime.remove_stopped_laptop_after_nix_for_worker(
            &cold.nix,
            &cold.plan,
            &mut cold.removal,
        );
        assert_eq!(result.is_err(), exact);
        assert_eq!(count(&fixture, "rm"), usize::from(!exact));
        if exact {
            settle_retained(&mut fixture, &mut cold);
        } else {
            reclaim(&fixture, cold);
        }
    }
}
#[test]
fn failed_nonforce_rm_stays_unknown_with_same_resources_and_no_retry() {
    if isolated(
        "worker_source_stop::tests::legacy::removal::faults::failed_nonforce_rm_stays_unknown_with_same_resources_and_no_retry",
    ) {
        return;
    }
    let mut fixture = Fixture::new("stop-requested");
    let mut cold = prepare(&fixture, false);
    fs::write(
        fixture.root.join("rm-nonzero"),
        b"real fixed client nonzero",
    )
    .unwrap();
    assert!(
        fixture
            .runtime
            .remove_stopped_laptop_after_nix_for_worker(&cold.nix, &cold.plan, &mut cold.removal)
            .is_err()
    );
    assert_eq!(count(&fixture, "rm"), 1);
    assert!(!fixture.root.join("old-removed").exists());
    settle_retained(&mut fixture, &mut cold);
    assert_eq!(count(&fixture, "rm"), 1);
}
#[test]
fn lost_rm_reply_after_actual_effect_keeps_unknown_after_native_settlement() {
    if isolated(
        "worker_source_stop::tests::legacy::removal::faults::lost_rm_reply_after_actual_effect_keeps_unknown_after_native_settlement",
    ) {
        return;
    }
    let mut fixture = Fixture::new("stop-requested");
    let mut cold = prepare(&fixture, false);
    fs::write(
        fixture.root.join("hold-rm-reply"),
        b"owned real effect then pending reply",
    )
    .unwrap();
    let release = Release(fixture.root.join("release-rm-reply"));
    assert!(
        fixture
            .runtime
            .remove_stopped_laptop_after_nix(
                &cold.nix,
                &cold.plan,
                &mut cold.removal,
                Instant::now() + Duration::from_millis(150)
            )
            .is_err()
    );
    assert!(fixture.root.join("rm-reply-held").exists());
    assert!(fixture.root.join("old-removed").exists());
    drop(release);
    settle_retained(&mut fixture, &mut cold);
    assert_eq!(count(&fixture, "rm"), 1);
}
#[test]
fn restart_after_last_inspect_cannot_turn_fixed_nonforce_rm_into_live_deletion() {
    if isolated(
        "worker_source_stop::tests::legacy::removal::faults::restart_after_last_inspect_cannot_turn_fixed_nonforce_rm_into_live_deletion",
    ) {
        return;
    }
    let mut fixture = Fixture::new("stop-requested");
    let mut cold = prepare(&fixture, false);
    fs::write(
        fixture.root.join("hold-rm-submit"),
        b"owned last inspect race",
    )
    .unwrap();
    std::thread::scope(|scope| {
        let release = Release(fixture.root.join("release-rm-submit"));
        let remove = scope.spawn(|| {
            fixture.runtime.remove_stopped_laptop_after_nix_for_worker(
                &cold.nix,
                &cold.plan,
                &mut cold.removal,
            )
        });
        wait(|| fixture.root.join("rm-entered").exists());
        let mut restarted = Target::new(&fixture);
        fs::write(
            fixture.root.join("rm-running"),
            b"actual restarted process alive before nonforce rm",
        )
        .unwrap();
        drop(release);
        assert!(remove.join().unwrap().is_err());
        assert!(restarted.child.try_wait().unwrap().is_none());
        assert!(!fixture.root.join("old-removed").exists());
    });
    settle_retained(&mut fixture, &mut cold);
    assert_eq!(
        fixture
            .trace()
            .iter()
            .find(|line| line.starts_with("rm\0"))
            .unwrap(),
        &format!("rm\0{}", fixture.row["Id"].as_str().unwrap())
    );
}
