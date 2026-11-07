use reverie_contracts::worker_source_stop::{
    OrdinaryContainer, OrdinaryNetwork, ordinary_container_absent, ordinary_network_absent,
};
use reverie_core::ids::{ContainerId, ProfileSessionId};
use serde_json::json;
const SID: &str = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
#[test]
fn actual_original_thirteen_running_shape_vectors_preserve_conditional_kill_data() {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/ordinary-stop-running-python.json")).unwrap();
    let sid = ProfileSessionId::parse(SID).unwrap();
    let cases = fixture["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 13);
    for case in cases {
        let state = OrdinaryContainer::decode(
            case["raw"].as_str().unwrap().as_bytes(),
            fixture["name"].as_str().unwrap(),
            "test",
            &sid,
        )
        .unwrap();
        assert_eq!(state.running(), case["conditional_kill"].as_bool().unwrap());
        assert_eq!(
            state.stopped(),
            case["strict_false_stopped"].as_bool().unwrap()
        );
    }
}
#[test]
fn original_first_row_truthiness_is_distinct_from_positive_stopped_acknowledgment() {
    let sid = ProfileSessionId::parse(SID).unwrap();
    let name = format!("test-agent-{SID}");
    for (running, truthy, stopped) in [
        (json!(false), false, true),
        (json!(0), false, false),
        (json!(null), false, false),
        (json!([]), false, false),
        (json!([0]), true, false),
        (json!("false"), true, false),
    ] {
        let raw = serde_json::to_vec(&json!([{"Id":"a".repeat(64),"Name":format!("/{name}"),"Config":{"Labels":{"reverie.worker":"test","reverie.session":SID}},"State":{"Running":running}}, {"ignored":"original first row"}])).unwrap();
        let row = OrdinaryContainer::decode(&raw, &name, "test", &sid).unwrap();
        assert_eq!(row.running(), truthy);
        assert_eq!(row.stopped(), stopped);
    }
}
#[test]
fn complete_censuses_refuse_duplicate_malformed_and_either_reused_name_or_original_id() {
    let id = ContainerId::parse(&"a".repeat(64)).unwrap();
    let row = format!("{} target\n", id.as_str());
    assert!(!ordinary_container_absent(row.as_bytes(), "target", None).unwrap());
    assert!(!ordinary_container_absent(row.as_bytes(), "renamed", Some(&id)).unwrap());
    assert!(ordinary_container_absent(b"", "target", Some(&id)).unwrap());
    assert!(ordinary_container_absent(format!("{row}{row}").as_bytes(), "target", None).is_err());
    for raw in [
        b"\n".as_slice(),
        b"truncated target\n",
        b"unparsed",
        b"\xff",
    ] {
        assert!(ordinary_container_absent(raw, "target", None).is_err());
    }
    assert!(!ordinary_network_absent(row.as_bytes(), "target", None).unwrap());
}
#[test]
fn foreign_network_remains_noop_but_owned_network_requires_immutable_id_and_exact_name() {
    let sid = ProfileSessionId::parse(SID).unwrap();
    assert!(
        OrdinaryNetwork::decode(
            br#"[{"Labels":{"reverie.worker":"foreign"}}]"#,
            "net",
            "test",
            &sid
        )
        .unwrap()
        .is_none()
    );
    let mut row = json!({"Id":"b".repeat(64),"Name":"net","Labels":{"reverie.worker":"test","reverie.session":SID}});
    let raw = serde_json::to_vec(&json!([row])).unwrap();
    let network = OrdinaryNetwork::decode(&raw, "net", "test", &sid)
        .unwrap()
        .unwrap();
    assert_eq!(network.id(), "b".repeat(64));
    row["Name"] = json!("reused");
    assert!(
        OrdinaryNetwork::decode(
            &serde_json::to_vec(&json!([row])).unwrap(),
            "net",
            "test",
            &sid
        )
        .is_err()
    );
}
