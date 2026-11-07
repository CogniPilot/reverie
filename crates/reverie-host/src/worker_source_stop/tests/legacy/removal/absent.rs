use super::*;
#[test]
fn actual_absence_at_stop_never_grants_removal_of_a_new_name_after_nix() {
    if isolated(
        "worker_source_stop::tests::legacy::removal::absent::actual_absence_at_stop_never_grants_removal_of_a_new_name_after_nix",
    ) {
        return;
    }
    for replaced in [false, true] {
        let mut fixture = Fixture::new("never");
        let (storage, plan, original) = inputs(&fixture);
        drop(original);
        fixture.release_target();
        fs::write(
            fixture.root.join("legacy-missing"),
            b"actual old target reaped",
        )
        .unwrap();
        let mut owner = fixture
            .runtime
            .retain_unobserved_ordinary_laptop_stop_for_worker(storage, plan)
            .unwrap_or_else(|_| panic!("same actual missing target owner"));
        owner.stop_after_admission(&fixture.runtime).unwrap();
        let (storage, plan, original, removal) = owner
            .take_stopped(&fixture.runtime, end())
            .unwrap()
            .into_cold_parts();
        assert!(original.is_none());
        let mut cold = nix(&fixture, storage, plan, removal);
        let mut foreign = if replaced {
            fs::remove_file(fixture.root.join("legacy-missing")).unwrap();
            // The old owned process was explicitly released and joined above.
            // Its release file is not a release of this new owned generation.
            fs::remove_file(fixture.root.join("release-source")).unwrap();
            Some(Target::new(&fixture))
        } else {
            None
        };
        let result = fixture.runtime.remove_stopped_laptop_after_nix_for_worker(
            &cold.nix,
            &cold.plan,
            &mut cold.removal,
        );
        assert_eq!(result.is_err(), replaced);
        assert_eq!(count(&fixture, "rm"), 0);
        if let Some(foreign) = &mut foreign {
            assert!(foreign.child.try_wait().unwrap().is_none());
            settle_retained(&mut fixture, &mut cold);
        } else {
            result
                .unwrap()
                .assert_workflow(&fixture.runtime, &cold.nix)
                .unwrap();
            reclaim(&fixture, cold);
        }
    }
}
