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
