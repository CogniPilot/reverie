//! Protected durable/resource join with real installing/recovery/Office owners.
//! Only the existing observer's kernel facts are synthetic. The positive
//! source is already stopped; it does not qualify a live container stop.
use super::*;
use crate::reservation_gate::RetainedPreparation;
use serde_json::{Value, json};

fn prepared(owned: &Owned) -> RetainedPreparation {
    owned.recover();
    owned.tail();
    let preview = owned.preview();
    let mut claim = owned
        .broker
        .retain_resource_draft(&preview.draft_id(), &preview.digest())
        .unwrap();
    claim.begin_prepare().unwrap();
    let receipt: Value = serde_json::from_slice(
        &fs::read(owned.setup.tree.root.join(format!(
            "control/operations/publication-{}.json",
            claim.operation_id().as_str()
        )))
        .unwrap(),
    )
    .unwrap();
    owned.setup.tree.write(
        "company.json",
        &serde_json::to_vec(&json!({"employees":[receipt["afterEmployee"]]})).unwrap(),
    );
    claim.confirm_publication().unwrap();
    owned.setup.tree.write(
        "inspect.out",
        &serde_json::to_vec(&json!([owned.setup.rows[1]])).unwrap(),
    );
    claim.commit_configuration().unwrap();
    owned.fixture.native_start_facts();
    claim
}

fn stopped(owned: &Owned) {
    let mut rows = owned.setup.rows.clone();
    rows[1]["State"] = json!({"Running":false,"Pid":0});
    // This fixture's metadata queries still use the SAME captured Runtime;
    // replace its actual closed child's input, not an unused output queue.
    owned.setup.tree.write(
        "inventory.out",
        rows.iter()
            .map(Value::to_string)
            .collect::<Vec<_>>()
            .join("\n")
            .as_bytes(),
    );
    owned.fixture.old_release("released");
}

#[test]
fn actual_stopped_source_closes_exact_phone_before_lease_and_keeps_starting_claim() {
    crate::test_process::owning_case!(
        actual_stopped_source_closes_exact_phone_before_lease_and_keeps_starting_claim
    );
    let owned = Owned::new();
    let mut claim = prepared(&owned);
    let intent = claim.begin_native_start().unwrap();
    let socket = owned
        .setup
        .tree
        .root
        .join("office")
        .join(owned.session().as_str())
        .join("office.sock");
    assert!(
        socket.exists(),
        "actual recovered phone remains until stopped qualification"
    );
    owned.assert_held();
    stopped(&owned);
    let facts = claim.stop_original_source(&intent).unwrap();
    assert_eq!(facts.state(), "SOURCE_RELEASED_TARGET_NOT_CREATED");
    assert!(facts.capacity_retained());
    assert!(!facts.retry_allowed() && !facts.verified());
    assert!(!socket.exists(), "the actual original phone closed");
    owned.assert_admission_free();
    // The original session no longer resolves as current after publication.
    // The physical lease is checked by its exact original identity below.
    let acquired = StorageLease::acquire_migration(
        owned.broker.configuration().unwrap().configuration(),
        intent.target_session(),
    )
    .unwrap();
    acquired.close().unwrap();
    let document = operations_v1::decode(&owned.journal()).unwrap();
    assert_eq!(
        document.operations()[claim.operation_id()].data().state,
        reverie_core::operations::OperationState::Starting
    );
    assert_eq!(
        claim.stop_original_source(&intent).err().unwrap().code(),
        "RESOURCE_NATIVE_SOURCE_STOP_ALREADY_ATTEMPTED"
    );
    claim.close().unwrap();
}

#[test]
fn actual_missing_phone_refuses_release_and_retains_original_lease_and_durable_claim() {
    crate::test_process::owning_case!(
        actual_missing_phone_refuses_release_and_retains_original_lease_and_durable_claim
    );
    let owned = Owned::new();
    let mut claim = prepared(&owned);
    let intent = claim.begin_native_start().unwrap();
    {
        let lifecycle = owned.broker.installed.lifecycle().unwrap();
        let LaptopOwner::Recovered(laptop) = &lifecycle.guard[0].owner else {
            panic!("real recovered owner")
        };
        laptop
            .office
            .close_for_stopped_source(Instant::now() + Duration::from_secs(5))
            .unwrap();
    }
    stopped(&owned);
    let error = claim.stop_original_source(&intent).err().unwrap();
    assert_eq!(
        error.code(),
        "RESOURCE_NATIVE_SOURCE_STOP_UNCERTAIN_KEEP_CLAIM"
    );
    assert!(
        StorageLease::acquire_migration(
            owned.broker.configuration().unwrap().configuration(),
            intent.target_session()
        )
        .is_err(),
        "missing phone is not evidence of checked cleanup for this transition"
    );
    owned.assert_admission_free();
    assert_eq!(
        operations_v1::decode(&owned.journal())
            .unwrap()
            .operations()[claim.operation_id()]
        .data()
        .state,
        reverie_core::operations::OperationState::Starting
    );
}
