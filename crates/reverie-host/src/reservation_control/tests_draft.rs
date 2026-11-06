use super::*;
use reverie_contracts::{reservation_draft::DraftRecord, storage_identity::decode_metadata};
use reverie_core::operations::{JournalDigest, JournalId, OperationScope};
fn record() -> DraftRecord {
    let cases: serde_json::Value = serde_json::from_str(include_str!(
        "../../../reverie-contracts/tests/fixtures/reservation-draft-python.json"
    ))
    .unwrap();
    let case = &cases[0];
    let raw = case["canonical"].as_str().unwrap();
    let data: serde_json::Value = serde_json::from_str(raw).unwrap();
    let scope = OperationScope {
        company_id: JournalId::parse(case["scope"]["company_id"].as_str().unwrap()).unwrap(),
        owner_scope_digest: JournalDigest::parse(
            case["scope"]["owner_scope_digest"].as_str().unwrap(),
        )
        .unwrap(),
    };
    DraftRecord::capture(
        &decode_metadata(raw.as_bytes()).unwrap(),
        &JournalId::parse(data["draftId"].as_str().unwrap()).unwrap(),
        &scope,
        &JournalDigest::parse(case["digest"].as_str().unwrap()).unwrap(),
    )
    .unwrap()
}
#[test]
fn draft_publication_is_exclusive_private_exact_and_checked_close_failure_never_acks() {
    let tree = Tree::new();
    let draft = record();
    let bytes = draft.canonical_bytes().unwrap();
    let path = tree.root.join(format!(
        "control/operations/draft-{}.json",
        draft.id().as_str()
    ));
    native::test_faults::set(None, true);
    assert!(publish_draft(&tree.config, &draft).is_err());
    assert_eq!(
        fs::read(&path).unwrap(),
        bytes,
        "lost close acknowledgement leaves the exclusive draft name intact"
    );
    assert_eq!(fs::metadata(&path).unwrap().mode() & 0o7777, 0o600);
    assert!(
        !fs::read_dir("/proc/self/fd")
            .unwrap()
            .filter_map(|entry| fs::read_link(entry.unwrap().path()).ok())
            .any(|target| target == path),
        "the owned file actually closed despite the refused acknowledgement"
    );
    assert!(
        publish_draft(&tree.config, &draft).is_err(),
        "exclusive publication never overwrites a retained name"
    );
    assert_eq!(fs::read(path).unwrap(), bytes);
}
