use super::*;
fn isolated(name: &str) -> bool {
    crate::test_process::isolate_case(&format!(
        "worker_laptop::tests::existing_viewer::transport::created_bridge::finalization::{name}"
    ))
}
pub(super) fn observation_row(fixture: &Fixture, running: bool, id: &str) {
    fs::write(
        fixture.root.join("created-final-inspect.json"),
        serde_json::to_vec(&json!([{
            "Id":id,"Name":format!("/fixture-agent-{SID}"),
            "Config":{"Labels":{"reverie.worker":"fixture","reverie.session":SID}},
            "State":{"Running":running}
        }]))
        .unwrap(),
    )
    .unwrap();
}
fn stopped(runtime: &WorkerRuntime, created: &CreatedLaptop) -> StoppedCreatedLaptop {
    let CreatedCleanup::Stopped(stopped) = runtime.stop_created_laptop(created, end()).unwrap()
    else {
        panic!("actual confirmed fixed CID stop")
    };
    runtime.close_created_laptop_viewer(created, end()).unwrap();
    stopped
}
#[test]
fn stopped_return_requires_closed_office_and_default_drop_keeps_same_resource_counted() {
    if isolated(
        "stopped_return_requires_closed_office_and_default_drop_keeps_same_resource_counted",
    ) {
        return;
    }
    let fixture = Fixture::employee("created-viewer-echo");
    let runtime = fixture.runtime();
    let service = Arc::new(WorkerReportService::from_runtime(runtime));
    let (_client, connection, mut hold) = accepted(&fixture, &service, "original");
    let (created, _released) = ready(&fixture, &connection);
    let stopped = stopped(runtime, &created);
    observation_row(&fixture, false, &"c".repeat(64));
    let observation = runtime.observe_created_final_storage(&created).unwrap();
    assert!(!observation.is_live());
    assert!(
        runtime
            .prepare_stopped_created_return(&stopped, &observation)
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
            .prepare_stopped_created_return(&stopped, &observation)
            .unwrap(),
    );
    assert!(StorageLease::acquire_migration(&fixture.source, &sid()).is_err());
    assert!(runtime.start_laptop_container(&created, end()).is_err());
    let returned = runtime
        .prepare_stopped_created_return(&stopped, &observation)
        .unwrap();
    let (storage, plan, _request, _closed_phone, failure) = returned.into_parts();
    assert_eq!(plan.session(), &sid());
    assert!(failure.is_none());
    assert!(runtime.created_laptop_stop_target(&created).is_err());
    assert!(StorageLease::acquire_migration(&fixture.source, &sid()).is_err());
    storage.close(end()).unwrap();
    StorageLease::acquire_migration(&fixture.source, &sid())
        .unwrap()
        .close()
        .unwrap();
    connection.close_socket(end()).unwrap();
    hold.release(end()).unwrap();
    service.close(end()).unwrap();
}
#[test]
fn fresh_live_or_identity_failure_cannot_return_a_previously_stopped_record() {
    if isolated("fresh_live_or_identity_failure_cannot_return_a_previously_stopped_record") {
        return;
    }
    for wrong in [false, true] {
        let fixture = Fixture::employee("created-viewer-echo");
        let runtime = fixture.runtime();
        let service = Arc::new(WorkerReportService::from_runtime(runtime));
        let (_client, connection, mut hold) = accepted(&fixture, &service, "original");
        let (created, _released) = ready(&fixture, &connection);
        let stopped = stopped(runtime, &created);
        observation_row(
            &fixture,
            true,
            &if wrong {
                "f".repeat(64)
            } else {
                "c".repeat(64)
            },
        );
        let result = runtime.observe_created_final_storage(&created);
        if wrong {
            assert!(result.is_err());
        } else {
            let observed = result.unwrap();
            assert!(observed.is_live());
            assert!(
                runtime
                    .prepare_stopped_created_return(&stopped, &observed)
                    .is_err()
            );
        }
        observation_row(&fixture, false, &"c".repeat(64));
        assert!(runtime.observe_created_final_storage(&created).is_err());
        assert!(StorageLease::acquire_migration(&fixture.source, &sid()).is_err());
        connection.close_socket(end()).unwrap();
        hold.release(end()).unwrap();
        service.close(end()).unwrap();
    }
}
#[test]
fn failed_optional_inspect_needs_successful_complete_absence_census() {
    if isolated("failed_optional_inspect_needs_successful_complete_absence_census") {
        return;
    }
    for target_present in [false, true] {
        let fixture = Fixture::employee("created-viewer-echo");
        let runtime = fixture.runtime();
        let service = Arc::new(WorkerReportService::from_runtime(runtime));
        let (_client, connection, mut hold) = accepted(&fixture, &service, "original");
        let (created, _released) = ready(&fixture, &connection);
        let _stopped = stopped(runtime, &created);
        observation_row(&fixture, false, &"c".repeat(64));
        fs::write(
            fixture.root.join("created-final-inspect-fail"),
            b"actual nonzero",
        )
        .unwrap();
        let census = if target_present {
            format!("{} fixture-agent-{SID}\n", "c".repeat(64))
        } else {
            String::new()
        };
        fs::write(fixture.root.join("created-final-census"), census).unwrap();
        let observed = runtime.observe_created_final_storage(&created);
        assert_eq!(observed.is_ok(), !target_present);
        if let Ok(observed) = observed {
            assert!(!observed.is_live());
        }
        assert!(StorageLease::acquire_migration(&fixture.source, &sid()).is_err());
        connection.close_socket(end()).unwrap();
        hold.release(end()).unwrap();
        service.close(end()).unwrap();
    }
}
