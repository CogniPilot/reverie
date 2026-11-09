//! The supervisor's actual completion accessor must distinguish lock pressure
//! from a failed native/storage outcome, without dispatching a new command.
use super::*;

fn trace(fixture: &Fixture) -> Vec<u8> {
    fs::read(fixture.root.join("trace")).unwrap()
}

#[test]
fn completion_contention_keeps_poison_and_unrelated_probes_fatal() {
    let lock = Mutex::new(());
    let held = lock.lock().unwrap();
    let ordinary = lock
        .try_lock()
        .map_err(|error| ReadContention::Retained.error(error));
    assert!(matches!(
        ordinary,
        Err(LaptopError::Refused("WORKER_LAPTOP_RETAINED"))
    ));
    drop(held);
    let poisoned = std::panic::catch_unwind(|| {
        let _held = lock.lock().unwrap();
        panic!("private fixture poisons its own empty mutex");
    });
    assert!(poisoned.is_err());
    let completion = lock
        .try_lock()
        .map_err(|error| ReadContention::CreatedReceipt.error(error));
    assert!(matches!(
        completion,
        Err(LaptopError::Refused("WORKER_LAPTOP_RETAINED"))
    ));
}

#[test]
fn contended_created_completion_is_pending_then_reads_same_selected_receipt() {
    if crate::test_process::isolate_case(
        "worker_laptop::tests::completion::contended_created_completion_is_pending_then_reads_same_selected_receipt",
    ) {
        return;
    }
    let fixture = Fixture::employee("created-normal");
    let runtime = fixture.runtime();
    let (workflow, created) = publication::created(&fixture);
    runtime.publish_laptop_launch(&created).unwrap();
    let ContainerStart::Started(_) = runtime.start_laptop_container(&created, end()).unwrap()
    else {
        panic!("actual fixed-fixture start");
    };
    let selected = {
        let record = created.workflow.record.lock().unwrap();
        record
            .creation
            .as_ref()
            .unwrap()
            .publication
            .as_ref()
            .unwrap()
            .selected_exit()
            .unwrap()
    };
    fs::write(selected, b"0").unwrap();
    let before = trace(&fixture);
    let held = created.workflow.record.lock().unwrap();
    let blocked_record = runtime
        .observe_created_laptop_receipt(&created)
        .err()
        .map(|error| error.code());
    drop(held);
    let inventory = runtime.laptop_workflows().records.lock().unwrap();
    let blocked_inventory = runtime
        .observe_created_laptop_receipt(&created)
        .err()
        .map(|error| error.code());
    drop(inventory);
    let observed = runtime.observe_created_laptop_receipt(&created).unwrap();
    let unchanged = trace(&fixture) == before;
    let matched = observed.same_workflow(&workflow) && observed.is_file();
    close_created(&fixture, &created);
    assert_eq!(blocked_record, Some("WORKER_CREATED_RECEIPT_PENDING"));
    assert_eq!(blocked_inventory, Some("WORKER_CREATED_RECEIPT_PENDING"));
    assert!(
        matched,
        "release must read the original selected completion"
    );
    assert!(
        unchanged,
        "completion probes must dispatch no native command"
    );
}

fn close_created(fixture: &Fixture, created: &CreatedLaptop) {
    let runtime = fixture.runtime();
    let CreatedCleanup::Stopped(stopped) = runtime.stop_created_laptop(created, end()).unwrap()
    else {
        panic!("known fixed-fixture CID stop");
    };
    runtime.close_created_laptop_viewer(created, end()).unwrap();
    runtime
        .cleanup_created_laptop_nix_guard(created, end())
        .unwrap();
    runtime.cleanup_created_laptop_request(created).unwrap();
    fs::write(
        fixture.root.join("created-final-inspect.json"),
        serde_json::to_vec(&json!([{
            "Id":"c".repeat(64),"Name":format!("/fixture-agent-{SID}"),
            "Config":{"Labels":{"reverie.worker":"fixture","reverie.session":SID}},
            "State":{"Running":false}
        }]))
        .unwrap(),
    )
    .unwrap();
    let observation = runtime.observe_created_final_storage(created).unwrap();
    assert!(!observation.is_live());
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
    assert!(failure.is_none());
    storage.close(end()).unwrap();
    runtime.close(end()).unwrap();
}
