use super::*;
pub(super) fn canonical_originals(fixture: &Fixture) -> Originals {
    let (storage, plan, request, _) = originals(fixture);
    let row = json!({"Id":"c".repeat(64),"Name":format!("/fixture-agent-{SID}"),"Config":{"Labels":{"reverie.worker":"fixture","reverie.session":SID}},"State":{"Running":true}});
    fs::write(
        fixture.root.join("existing-inspect.json"),
        serde_json::to_vec(&json!([row])).unwrap(),
    )
    .unwrap();
    let mut after = row;
    after["State"]["Running"] = json!(false);
    fs::write(
        fixture.root.join("existing-after.json"),
        serde_json::to_vec(&json!([after])).unwrap(),
    )
    .unwrap();
    fs::write(
        fixture.root.join("existing-stop-control"),
        b"owned fixed engine",
    )
    .unwrap();
    fs::write(
        fixture.root.join("existing-stop-census"),
        format!("{} fixture-agent-{SID}\n", "c".repeat(64)),
    )
    .unwrap();
    let inspected = plan
        .inspect_existing(fixture.runtime(), end())
        .unwrap()
        .unwrap();
    (storage, plan, request, inspected)
}
#[test]
fn actual_viewer_is_still_usable_after_provider_stop_and_reaped_only_before_same_box_restore() {
    if isolated(
        "stop::actual_viewer_is_still_usable_after_provider_stop_and_reaped_only_before_same_box_restore",
    ) {
        return;
    }
    let fixture = Fixture::employee("created-viewer-echo");
    let originals = canonical_originals(&fixture);
    let address = std::ptr::from_ref(originals.0.as_ref());
    let existing = retain(&fixture, originals);
    let viewer = start(&fixture, &existing);
    fixture
        .runtime()
        .stop_existing_viewer_laptop_for_worker(&existing)
        .unwrap();
    assert!(fixture.root.join("stopped-laptop").is_file());
    fixture
        .runtime()
        .write_laptop_viewer(&viewer, b"Z")
        .unwrap();
    let mut observed = Vec::new();
    wait(|| {
        let mut bytes = [0; 16];
        match fixture.runtime().read_laptop_viewer(&viewer, &mut bytes) {
            Ok(n) => observed.extend_from_slice(&bytes[..n]),
            Err(LaptopError::Io(error)) if error.kind() == std::io::ErrorKind::WouldBlock => {}
            other => panic!("read: {other:?}"),
        };
        observed == b"Z"
    });
    assert!(
        fixture
            .runtime()
            .reclaim_existing_viewer(&existing)
            .is_err()
    );
    fixture
        .runtime()
        .close_existing_viewer(&existing, end())
        .unwrap();
    let storage = restore(&fixture, &existing);
    assert_eq!(std::ptr::from_ref(storage.as_ref()), address);
    storage.close(end()).unwrap();
}
#[test]
fn unknown_provider_stop_blocks_same_box_reclaim_after_actual_viewer_and_query_cleanup() {
    if isolated(
        "stop::unknown_provider_stop_blocks_same_box_reclaim_after_actual_viewer_and_query_cleanup",
    ) {
        return;
    }
    let fixture = Fixture::employee("created-viewer-echo");
    let originals = canonical_originals(&fixture);
    let existing = retain(&fixture, originals);
    let viewer = start(&fixture, &existing);
    fs::write(
        fixture.root.join("existing-stop-failed-inspect"),
        b"unknown provider",
    )
    .unwrap();
    assert!(
        fixture
            .runtime()
            .stop_existing_viewer_laptop(&existing, end())
            .is_err()
    );
    fixture
        .runtime()
        .write_laptop_viewer(&viewer, b"X")
        .unwrap();
    fixture
        .runtime()
        .close_existing_viewer(&existing, end())
        .unwrap();
    assert!(
        fixture
            .runtime()
            .reclaim_existing_viewer(&existing)
            .is_err()
    );
    assert!(
        fixture
            .runtime()
            .stop_existing_viewer_laptop(&existing, end())
            .is_err()
    );
    assert!(StorageLease::acquire_migration(&fixture.source, &sid()).is_err());
    assert!(fixture.runtime().close(end()).is_err());
}
#[test]
fn completed_before_viewer_constructor_stops_with_original_inputs_without_fabricating_job() {
    if isolated(
        "stop::completed_before_viewer_constructor_stops_with_original_inputs_without_fabricating_job",
    ) {
        return;
    }
    let fixture = Fixture::employee("created-viewer-echo");
    let existing = retain(&fixture, canonical_originals(&fixture));
    fixture
        .runtime()
        .stop_existing_viewer_laptop_for_worker(&existing)
        .unwrap();
    assert!(!fixture.root.join("viewer-ready").exists());
    assert!(
        fixture
            .runtime()
            .start_existing_viewer(&existing, end())
            .is_err()
    );
    fixture
        .runtime()
        .close_existing_viewer(&existing, end())
        .unwrap();
    restore(&fixture, &existing).close(end()).unwrap();
}
#[test]
fn retained_constructor_keeps_actual_slot_and_original_failure_when_stop_cannot_admit() {
    if isolated(
        "stop::retained_constructor_keeps_actual_slot_and_original_failure_when_stop_cannot_admit",
    ) {
        return;
    }
    let fixture = Fixture::employee("created-viewer-echo");
    let existing = retain(&fixture, canonical_originals(&fixture));
    crate::worker_laptop::viewer::test_hooks::refuse_next_input_close();
    assert!(matches!(
        fixture
            .runtime()
            .start_existing_viewer(&existing, end())
            .unwrap(),
        ExistingViewerStart::Retained
    ));
    let original = existing.failure().unwrap().unwrap();
    assert!(
        fixture
            .runtime()
            .stop_existing_viewer_laptop(&existing, end())
            .is_err()
    );
    assert!(Arc::ptr_eq(
        &original,
        &existing.failure().unwrap().unwrap()
    ));
    assert!(
        !fixture.root.join("stopped-laptop").is_file(),
        "the actual constructor still owns shared client admission"
    );
    assert!(
        fixture
            .runtime()
            .close_existing_viewer(&existing, end())
            .is_err()
    );
    assert!(
        fixture
            .runtime()
            .reclaim_existing_viewer(&existing)
            .is_err()
    );
    assert!(StorageLease::acquire_migration(&fixture.source, &sid()).is_err());
}
