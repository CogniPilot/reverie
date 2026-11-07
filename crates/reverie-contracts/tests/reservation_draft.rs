use reverie_contracts::{
    profiles_v1,
    reservation_draft::{self, DraftFields, DraftRecord},
    reservation_observation::{ReservationObservation, ReservationObservationFields},
    storage_identity::decode_metadata,
};
use reverie_core::{
    ids::{ProfileEmployeeId, ProfileSessionId},
    operations::{JournalDigest, JournalId, MemoryBytes, OperationDocument, OperationScope},
    profiles::ResourceProfile,
    revision::{Generation, ProfileVersion},
};
use serde_json::{Value, json};
fn profile(value: &Value) -> ResourceProfile {
    let mut profiles = serde_json::Map::new();
    profiles.insert(
        value["binding"]["employee_id"].as_str().unwrap().to_owned(),
        value.clone(),
    );
    profiles_v1::decode(
        &serde_json::to_vec(
            &json!({"schema":profiles_v1::SCHEMA,"revision":1,"profiles":profiles}),
        )
        .unwrap(),
    )
    .unwrap()
    .profiles()
    .values()
    .next()
    .unwrap()
    .clone()
}
fn observed(value: &Value) -> ReservationObservation {
    let text = |name| value[name].as_str().unwrap();
    let integer = |name| text(name).parse::<u64>().unwrap();
    ReservationObservation::try_new(ReservationObservationFields {
        pool: JournalId::parse(text("pool_id")).unwrap(),
        pool_revision: JournalDigest::parse(text("pool_revision_digest")).unwrap(),
        budget_bytes: integer("budget_bytes"),
        committed_bytes: integer("committed_bytes"),
        employee: ProfileEmployeeId::parse(text("employee_id")).unwrap(),
        current_session: ProfileSessionId::parse(text("current_sid")).unwrap(),
        generation: Generation::try_new(integer("generation")).unwrap(),
        source_binding: JournalDigest::parse(text("source_binding_digest")).unwrap(),
        profile_version: ProfileVersion::try_new(integer("profile_version")).unwrap(),
        current_memory: MemoryBytes::try_new(integer("current_memory_bytes")).unwrap(),
    })
    .unwrap()
}
#[test]
fn actual_legacy_draft_bytes_hashes_and_nil_preview_claim_boundary_match() {
    let cases: Value =
        serde_json::from_str(include_str!("fixtures/reservation-draft-python.json")).unwrap();
    for case in cases.as_array().unwrap() {
        let raw = case["canonical"].as_str().unwrap();
        let record: Value = serde_json::from_str(raw).unwrap();
        let id = |name| JournalId::parse(record[name].as_str().unwrap()).unwrap();
        let scope = OperationScope {
            company_id: JournalId::parse(case["scope"]["company_id"].as_str().unwrap()).unwrap(),
            owner_scope_digest: JournalDigest::parse(
                case["scope"]["owner_scope_digest"].as_str().unwrap(),
            )
            .unwrap(),
        };
        let profile = profile(&case["profile"]);
        let observed = observed(&case["observation"]);
        let draft = DraftRecord::from_observed_data(
            DraftFields {
                draft: &id("draftId"),
                key: &id("idempotencyKey"),
                operation: &id("operationId"),
                reservation: &id("reservationId"),
                scope: &scope,
                profile: &profile,
                observed: &observed,
            },
            &OperationDocument::empty(),
        )
        .unwrap();
        assert_eq!(
            draft.canonical_bytes().unwrap(),
            raw.as_bytes(),
            "{}",
            case["name"]
        );
        assert_eq!(
            draft.digest().unwrap().as_str(),
            case["digest"].as_str().unwrap()
        );
        let metadata = decode_metadata(raw.as_bytes()).unwrap();
        let captured =
            DraftRecord::capture(&metadata, &id("draftId"), &scope, &draft.digest().unwrap());
        assert_eq!(
            captured.is_ok(),
            case["claimObservationAccepted"].as_bool().unwrap()
        );
        if let Ok(captured) = captured {
            captured.assert_current_profile(Some(&profile)).unwrap();
            assert_eq!(
                captured.request().unwrap().preview_digest,
                draft.digest().unwrap()
            );
        }
    }
}
#[test]
fn directory_count_includes_unrelated_entries_and_refuses_the_256th_draft() {
    let points = |name: &str| name.chars().map(u32::from).collect::<Vec<_>>();
    let mut names = vec![points("ordinary"); 4096];
    reservation_draft::validate_directory_names(&names).unwrap();
    names.push(points("ordinary"));
    assert_eq!(
        reservation_draft::validate_directory_names(&names)
            .unwrap_err()
            .code(),
        "RESOURCE_PREPARATION_DRAFT_BOUND"
    );
    let mut names = vec![points("draft-a.json"); 255];
    names.extend(vec![points("other"); 3841]);
    reservation_draft::validate_directory_names(&names).unwrap();
    names[255] = points("draft-b.json");
    assert!(reservation_draft::validate_directory_names(&names).is_err());
}
