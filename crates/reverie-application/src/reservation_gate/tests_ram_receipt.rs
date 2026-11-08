//! Actual journal/CAS/reload receipts with controlled native observations.
//! These do not fabricate a successful Q owner or a protected launch.
use super::*;
use reverie_contracts::{
    human_protocol::HumanFrame, ram_migration::RamMigrationPolicy,
    resource_actor::ResourceOperationRequest,
};

fn approval(claim: &RetainedPreparation, policy: &RamMigrationPolicy) -> Value {
    json!({"kind":"resource-operation","requestId":"88888888-2222-4333-8444-555555555555","verb":"claim","approval":{
        "employeeId":claim.profile().binding().employee().as_str(),
        "draftId":claim.draft.id().as_str(),
        "operationId":claim.operation_id().as_str(),
        "reservationId":claim.view.record().data().reservation_id.as_str(),
        "targetSid":claim.profile().binding().target_session().as_str(),
        "profileVersion":claim.profile().version().get().to_string(),
        "profileDigest":reverie_contracts::profiles_v1::profile_digest(claim.profile()).unwrap().to_hex(),
        "previewDigest":claim.draft.digest().unwrap().as_str(),
        "ramPolicyDigest":policy.digest().as_str()
    }})
}
fn decoded(raw: &Value) -> ResourceOperationRequest {
    ResourceOperationRequest::decode(
        &HumanFrame::decode(&serde_json::to_vec(raw).unwrap()).unwrap(),
    )
    .unwrap()
}

#[test]
fn ram_receipt_adopts_only_exact_installed_arc_once_without_native_work_or_capacity_credit() {
    crate::test_process::owning_case!(
        ram_receipt_adopts_only_exact_installed_arc_once_without_native_work_or_capacity_credit
    );
    let (_setup, fixture, gate, mut claim, _path) = ram_preparing(512, None);
    let before = gate.inner.installed.snapshot().unwrap();
    let policy = claim.ram_migration_policy().unwrap();
    claim
        .assert_ram_approval(&decoded(&approval(&claim, &policy)), &policy)
        .unwrap();
    let mut receipt = claim.commit_ram_configuration(&policy).unwrap();
    let installed = gate.inner.installed.snapshot().unwrap();
    assert!(!Arc::ptr_eq(&before, &installed));
    let events = fixture.events();
    let actual = receipt
        .rebase_ram_snapshot(Ok(&gate), &claim, &policy, &before)
        .unwrap();
    assert!(Arc::ptr_eq(&actual, &installed));
    assert_eq!(
        receipt
            .rebase_ram_snapshot(Ok(&gate), &claim, &policy, &before)
            .err()
            .unwrap()
            .code(),
        "RAM_PUBLICATION_REBASE_ALREADY_ATTEMPTED"
    );
    assert_eq!(fixture.events(), events);
    assert_eq!(claim.operation().state(), OperationState::Prepared);
    assert!(claim.operation().reservation_retained());
    assert!(!claim.operation().retry_allowed());
    claim.close().unwrap();
}

#[test]
fn ram_receipt_foreign_snapshot_and_closed_claim_refusals_are_sticky_with_real_owner_retained() {
    crate::test_process::owning_case!(
        ram_receipt_foreign_snapshot_and_closed_claim_refusals_are_sticky_with_real_owner_retained
    );
    for close_claim in [false, true] {
        let (_setup, fixture, gate, mut claim, path) = ram_preparing(512, None);
        let before = gate.inner.installed.snapshot().unwrap();
        let separately_loaded_before = Arc::new(load_owner_config(&path).unwrap());
        assert!(worker_config::equivalent(
            before.configuration(),
            separately_loaded_before.configuration()
        ));
        assert!(!Arc::ptr_eq(&before, &separately_loaded_before));
        let policy = claim.ram_migration_policy().unwrap();
        let mut receipt = claim.commit_ram_configuration(&policy).unwrap();
        let expected = if close_claim {
            claim.close_owned().unwrap();
            before.clone()
        } else {
            separately_loaded_before
        };
        let events = fixture.events();
        assert_eq!(
            receipt
                .rebase_ram_snapshot(Ok(&gate), &claim, &policy, &expected)
                .err()
                .unwrap()
                .code(),
            "RAM_PUBLICATION_OWNER_CHANGED"
        );
        assert_eq!(
            receipt
                .rebase_ram_snapshot(Ok(&gate), &claim, &policy, &before)
                .err()
                .unwrap()
                .code(),
            "RAM_PUBLICATION_REBASE_ALREADY_ATTEMPTED"
        );
        assert_eq!(fixture.events(), events);
        assert!(claim.operation().reservation_retained());
        if !close_claim {
            claim.close().unwrap();
        }
    }
}

#[test]
fn ordinary_publication_and_live_admission_cannot_rebase_ram_authority() {
    crate::test_process::owning_case!(
        ordinary_publication_and_live_admission_cannot_rebase_ram_authority
    );
    for ordinary in [true, false] {
        let (_setup, fixture, gate, mut claim, _path) = ram_preparing(512, None);
        let before = gate.inner.installed.snapshot().unwrap();
        let policy = claim.ram_migration_policy().unwrap();
        let mut receipt = if ordinary {
            claim.commit_configuration().unwrap()
        } else {
            claim.commit_ram_configuration(&policy).unwrap()
        };
        let admission = if ordinary {
            None
        } else {
            Some(gate.inner.admit(AdmissionBounds::default()).unwrap())
        };
        let events = fixture.events();
        let expected = if ordinary {
            "RAM_PUBLICATION_OWNER_CHANGED"
        } else {
            "RAM_PUBLICATION_REBASE_REQUIRES_CLOSED_ADMISSION"
        };
        assert_eq!(
            receipt
                .rebase_ram_snapshot(Ok(&gate), &claim, &policy, &before)
                .err()
                .unwrap()
                .code(),
            expected
        );
        if let Some(admission) = admission {
            admission.finish().unwrap();
        }
        assert_eq!(
            receipt
                .rebase_ram_snapshot(Ok(&gate), &claim, &policy, &before)
                .err()
                .unwrap()
                .code(),
            "RAM_PUBLICATION_REBASE_ALREADY_ATTEMPTED"
        );
        assert_eq!(fixture.events(), events);
        claim.close().unwrap();
    }
}

#[test]
fn ram_approval_requires_every_original_draft_binding_and_original_canonical_version() {
    crate::test_process::owning_case!(
        ram_approval_requires_every_original_draft_binding_and_original_canonical_version
    );
    let (_setup, fixture, _gate, claim, _path) = ram_preparing(512, None);
    let policy = claim.ram_migration_policy().unwrap();
    let actual = approval(&claim, &policy);
    claim
        .assert_ram_approval(&decoded(&actual), &policy)
        .unwrap();
    let events = fixture.events();
    for field in [
        "employeeId",
        "draftId",
        "operationId",
        "reservationId",
        "targetSid",
        "profileVersion",
        "profileDigest",
        "previewDigest",
        "ramPolicyDigest",
    ] {
        let mut changed = actual.clone();
        changed["approval"][field] = if field.ends_with("Digest") {
            json!("f".repeat(64))
        } else if field == "profileVersion" {
            json!("2")
        } else {
            json!("99999999-2222-4333-8444-555555555555")
        };
        assert_eq!(
            claim
                .assert_ram_approval(&decoded(&changed), &policy)
                .unwrap_err()
                .code(),
            "RAM_APPROVAL_CHANGED",
            "{field}"
        );
    }
    let mut numeric = actual;
    numeric["approval"]["profileVersion"] = json!(claim.profile().version().get());
    assert_eq!(
        claim
            .assert_ram_approval(&decoded(&numeric), &policy)
            .unwrap_err()
            .code(),
        "RAM_APPROVAL_CHANGED"
    );
    assert_eq!(fixture.events(), events);
    claim.close().unwrap();
}
