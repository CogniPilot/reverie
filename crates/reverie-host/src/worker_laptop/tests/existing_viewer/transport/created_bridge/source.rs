//! Protected name remains contract DATA; these controls exercise pure custody
//! transfer/refusal only, never a fabricated claim or native stop permission.
use super::*;
use reverie_contracts::{
    reservation_baseline::{OriginalBaselineFields, OriginalRuntimeTail, OriginalSourceBaseline},
    reservation_engine::{InventoryRows, NativeLimitBinding, NativeStorageBinding},
    worker_schema::WorkerEnvelope,
    worker_source_stop::SourceStopName,
};
use reverie_core::{decimal::UnsignedInteger, ids::ContainerId, posix_path::PosixPath};
fn name(fixture: &Fixture, id: &str) -> SourceStopName {
    let reference: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../../../../reverie-contracts/tests/fixtures/source-stop-python.json"
    ))
    .unwrap();
    let mut rows: serde_json::Value =
        serde_json::from_str(reference["cases"][0]["before"].as_str().unwrap()).unwrap();
    let row = &mut rows[0];
    row["Id"] = json!(id);
    row["Name"] = json!(format!("/fixture-agent-{SID}"));
    row["Config"]["Labels"]["reverie.worker"] = json!("fixture");
    row["Config"]["Labels"]["reverie.session"] = json!(SID);
    row["State"]["Pid"] = json!(std::process::id());
    row["HostConfig"] =
        json!({"Memory":512*1_048_576,"MemorySwap":512*1_048_576,"PidsLimit":128,"NanoCpus":0});
    let id = ContainerId::parse(id).unwrap();
    let inventory = InventoryRows::decode(&[id], &[row.to_string()]).unwrap();
    let row = &inventory.rows()[0];
    let zero = UnsignedInteger::from_u64(0);
    let start = reverie_contracts::kernel_accounting::process_start(
        &fs::read_to_string(format!("/proc/{}/stat", std::process::id())).unwrap(),
    )
    .unwrap();
    let native = NativeLimitBinding::from_observed_data(
        row,
        &row.declarations(&zero).unwrap(),
        &start,
        &PosixPath::from_scalar_text("pure-created-source-custody"),
        None,
    )
    .unwrap();
    let baseline = OriginalSourceBaseline::from_observed_data(OriginalBaselineFields {
        source: row,
        native: &native,
        storage: &NativeStorageBinding::from_observed_data([[1, 1, 1000, 100]; 3]),
        site: &native,
        commitments: &[],
        total: &zero,
        budget: &zero,
        runtime: &OriginalRuntimeTail::from_observed_data([1, 1], vec![]),
    });
    SourceStopName::from_baseline(
        WorkerEnvelope::capture(fixture.source.clone())
            .unwrap()
            .base(),
        &baseline,
    )
    .unwrap()
}
#[test]
fn protected_stop_transfer_refuses_wrong_target_and_restores_legacy_factory_refusal() {
    if crate::test_process::isolate_case(
        "worker_laptop::tests::existing_viewer::transport::created_bridge::source::protected_stop_transfer_refuses_wrong_target_and_restores_legacy_factory_refusal",
    ) {
        return;
    }
    for employee in [false, true] {
        let fixture = if employee {
            Fixture::employee("created-viewer-echo")
        } else {
            Fixture::new("created-viewer-echo")
        };
        let runtime = fixture.runtime();
        let service = Arc::new(WorkerReportService::from_runtime(runtime));
        let (_client, original, mut hold) = accepted(&fixture, &service, "original");
        let (created, _released) = ready(&fixture, &original);
        original.close_socket(end()).unwrap();
        hold.release(end()).unwrap();
        let source = runtime.retain_started_laptop_source(&created).unwrap();
        let wrong = name(&fixture, &"f".repeat(64));
        assert!(
            runtime
                .transfer_started_source_stop(&source, wrong, &fixture.source, None)
                .is_err()
        );
        runtime
            .borrow_started_source_storage(&source)
            .unwrap()
            .check_resource_current()
            .unwrap();
        let correct = name(&fixture, &"c".repeat(64));
        let result = runtime.transfer_started_source_stop(&source, correct, &fixture.source, None);
        if employee {
            let (stop, phone, _request) = result.unwrap().into_parts();
            assert!(runtime.borrow_started_source_storage(&source).is_err());
            assert!(runtime.created_laptop_stop_target(&created).is_err());
            drop(stop);
            assert!(StorageLease::acquire_migration(&fixture.source, &sid()).is_err());
            fixture.office.close_phone(&phone, end()).unwrap();
        } else {
            assert!(result.is_err());
            let borrowed = runtime.borrow_started_source_storage(&source).unwrap();
            assert_eq!(
                borrowed.ownership_kind(),
                crate::worker_storage::StorageOwnershipKind::UnleasedLegacy
            );
            borrowed.assert_binding(&fixture.source, &sid()).unwrap();
            drop(borrowed);
            runtime.restore_unclaimed_started_source(&source).unwrap();
        }
        assert!(!fixture.root.join("stopped-laptop").exists());
        service.close(end()).unwrap();
    }
}
#[test]
fn already_stopped_source_returns_same_resource_without_forced_stop_after_actual_office_close() {
    if crate::test_process::isolate_case(
        "worker_laptop::tests::existing_viewer::transport::created_bridge::source::already_stopped_source_returns_same_resource_without_forced_stop_after_actual_office_close",
    ) {
        return;
    }
    let fixture = Fixture::employee("created-viewer-echo");
    let runtime = fixture.runtime();
    let service = Arc::new(WorkerReportService::from_runtime(runtime));
    let (_client, original, mut hold) = accepted(&fixture, &service, "original");
    let (created, _released) = ready(&fixture, &original);
    original.close_socket(end()).unwrap();
    hold.release(end()).unwrap();
    let source = runtime.retain_started_laptop_source(&created).unwrap();
    super::finalization::observation_row(&fixture, false, &"c".repeat(64));
    let observed = runtime
        .observe_started_source_final_storage(&source)
        .unwrap();
    assert!(!observed.is_live());
    assert!(observed.same_source(&source));
    assert!(
        runtime
            .prepare_stopped_started_source_return(&source, &observed)
            .is_err()
    );
    {
        let record = created.workflow.record.lock().unwrap();
        fixture
            .office
            .close_phone(&record.resources().office, end())
            .unwrap();
    }
    drop(
        runtime
            .prepare_stopped_started_source_return(&source, &observed)
            .unwrap(),
    );
    assert!(StorageLease::acquire_migration(&fixture.source, &sid()).is_err());
    assert!(runtime.restore_unclaimed_started_source(&source).is_err());
    let returned = runtime
        .prepare_stopped_started_source_return(&source, &observed)
        .unwrap();
    let (storage, _plan, _request, _closed_phone, failure) = returned.into_parts();
    assert!(failure.is_none());
    assert!(runtime.borrow_started_source_storage(&source).is_err());
    assert!(runtime.created_laptop_stop_target(&created).is_err());
    let trace = fs::read_to_string(fixture.root.join("trace")).unwrap();
    assert!(
        !trace
            .lines()
            .any(|line| line.starts_with("stop\0") || line.starts_with("kill\0"))
    );
    assert!(StorageLease::acquire_migration(&fixture.source, &sid()).is_err());
    storage.close(end()).unwrap();
    service.close(end()).unwrap();
}
#[test]
fn final_source_live_and_foreign_identity_observations_remain_retained_without_reclassification() {
    if crate::test_process::isolate_case(
        "worker_laptop::tests::existing_viewer::transport::created_bridge::source::final_source_live_and_foreign_identity_observations_remain_retained_without_reclassification",
    ) {
        return;
    }
    for foreign in [false, true] {
        let fixture = Fixture::employee("created-viewer-echo");
        let runtime = fixture.runtime();
        let service = Arc::new(WorkerReportService::from_runtime(runtime));
        let (_client, original, mut hold) = accepted(&fixture, &service, "original");
        let (created, _released) = ready(&fixture, &original);
        original.close_socket(end()).unwrap();
        hold.release(end()).unwrap();
        let source = runtime.retain_started_laptop_source(&created).unwrap();
        super::finalization::observation_row(
            &fixture,
            true,
            &if foreign {
                "f".repeat(64)
            } else {
                "c".repeat(64)
            },
        );
        let observed = runtime.observe_started_source_final_storage(&source);
        if foreign {
            assert!(observed.is_err());
        } else {
            let observed = observed.unwrap();
            assert!(observed.is_live());
            assert!(
                runtime
                    .prepare_stopped_started_source_return(&source, &observed)
                    .is_err()
            );
        }
        assert!(runtime.restore_unclaimed_started_source(&source).is_err());
        assert!(
            runtime
                .transfer_started_source_stop(
                    &source,
                    name(&fixture, &"c".repeat(64)),
                    &fixture.source,
                    None
                )
                .is_err()
        );
        assert!(
            runtime
                .observe_started_source_final_storage(&source)
                .is_err()
        );
        assert!(StorageLease::acquire_migration(&fixture.source, &sid()).is_err());
        assert!(!fixture.root.join("stopped-laptop").exists());
        service.close(end()).unwrap();
    }
}
