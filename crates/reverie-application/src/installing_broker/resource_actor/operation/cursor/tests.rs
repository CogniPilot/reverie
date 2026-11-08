//! Pure cursor DATA controls. These never construct an authenticated Q owner.
use super::*;
use serde_json::json;
const REF: &str = "99999999-2222-4333-8444-555555555555";
const INITIAL: &str = "22222222-2222-4333-8444-555555555555";
fn original() -> ResourceOperationRequest {
    let value = json!({"kind":"resource-operation","requestId":INITIAL,"verb":"claim","approval":{
        "employeeId":"11111111-2222-4333-8444-555555555555","draftId":"44444444-2222-4333-8444-555555555555","operationId":"55555555-2222-4333-8444-555555555555","reservationId":"66666666-2222-4333-8444-555555555555","targetSid":"77777777-2222-4333-8444-555555555555",
        "profileVersion":"1","profileDigest":"a".repeat(64),"previewDigest":"b".repeat(64),"ramPolicyDigest":"c".repeat(64)}});
    ResourceOperationRequest::decode(
        &HumanFrame::decode(&serde_json::to_vec(&value).unwrap()).unwrap(),
    )
    .unwrap()
}
fn next(verb: &str, n: u8, reference: &str) -> ResourceContinuationRequest {
    let value = json!({"kind":"resource-operation","requestId":format!("{n:08}-2222-4333-8444-555555555555"),"verb":verb,"reference":reference});
    ResourceContinuationRequest::decode(
        &HumanFrame::decode(&serde_json::to_vec(&value).unwrap()).unwrap(),
    )
    .unwrap()
}
#[test]
fn original_cursor_is_bounded_to_four_distinct_ordered_phases() {
    let mut cursor = OperationCursor::default();
    let original = original();
    let reference = NativeOperationId::parse(REF).unwrap();
    for (n, verb, phase) in [
        (3, "publication", ResourceContinuationVerb::Publication),
        (4, "prepare", ResourceContinuationVerb::Prepare),
        (5, "source-stop", ResourceContinuationVerb::SourceStop),
        (6, "start", ResourceContinuationVerb::Start),
    ] {
        cursor
            .accept(next(verb, n, REF), &original, &reference, phase)
            .unwrap();
    }
    assert_eq!(cursor.seen.len(), 4);
    assert!(
        cursor
            .accept(
                next("start", 7, REF),
                &original,
                &reference,
                ResourceContinuationVerb::Start
            )
            .is_err()
    );
    assert_eq!(cursor.seen.len(), 4);
    assert_eq!(
        cursor.current().unwrap().verb(),
        ResourceContinuationVerb::Start
    );
}
#[test]
fn out_of_order_and_foreign_reference_never_advance_original_cursor() {
    let mut cursor = OperationCursor::default();
    let original = original();
    let reference = NativeOperationId::parse(REF).unwrap();
    assert!(
        cursor
            .accept(
                next("prepare", 3, REF),
                &original,
                &reference,
                ResourceContinuationVerb::Prepare
            )
            .is_err()
    );
    assert!(
        cursor
            .accept(
                next("publication", 3, INITIAL),
                &original,
                &reference,
                ResourceContinuationVerb::Publication
            )
            .is_err()
    );
    assert!(cursor.current().is_none());
    assert!(cursor.seen.is_empty());
    cursor
        .accept(
            next("publication", 3, REF),
            &original,
            &reference,
            ResourceContinuationVerb::Publication,
        )
        .unwrap();
}
#[test]
fn request_id_reuse_cannot_advance_the_same_owned_phase() {
    let mut cursor = OperationCursor::default();
    let original = original();
    let reference = NativeOperationId::parse(REF).unwrap();
    let collision =
        json!({"kind":"resource-operation","requestId":REF,"verb":"publication","reference":REF});
    let collision = ResourceContinuationRequest::decode(
        &HumanFrame::decode(&serde_json::to_vec(&collision).unwrap()).unwrap(),
    )
    .unwrap();
    assert!(
        cursor
            .accept(
                collision,
                &original,
                &reference,
                ResourceContinuationVerb::Publication
            )
            .is_err()
    );
    assert!(cursor.current().is_none());
    cursor
        .accept(
            next("publication", 3, REF),
            &original,
            &reference,
            ResourceContinuationVerb::Publication,
        )
        .unwrap();
    assert!(
        cursor
            .accept(
                next("prepare", 3, REF),
                &original,
                &reference,
                ResourceContinuationVerb::Prepare
            )
            .is_err()
    );
    assert_eq!(cursor.seen.len(), 1);
    assert_eq!(
        cursor.current().unwrap().verb(),
        ResourceContinuationVerb::Publication
    );
    cursor
        .accept(
            next("prepare", 4, REF),
            &original,
            &reference,
            ResourceContinuationVerb::Prepare,
        )
        .unwrap();
}
