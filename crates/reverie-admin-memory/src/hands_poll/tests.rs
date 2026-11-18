use super::{Claim, Room, file, rooms, state::Change};
use crate::hands_addressing::Scope;
use serde_json::{Value, json};
use std::{
    fs,
    os::unix::fs::{PermissionsExt, symlink},
};

fn message(id: &str, at: u64, session: &str, wake: bool) -> Value {
    json!({"id":id,"at":at,"from":{"sessionId":session,"kind":"agent"},"phoneWake":wake})
}

#[test]
fn first_room_read_seeds_the_bounded_backlog_and_keeps_older_state_fields() {
    let mut state: Room = serde_json::from_value(json!({"owner_state": {"choice": 7}})).unwrap();
    let history: Vec<_> = (0..505)
        .map(|id| message(&format!("m-{id}"), id, "other", true))
        .collect();
    assert!(state.initialize(&history, Some("latest".into())));
    assert!(!state.initialize(&[], None));
    let saved = serde_json::to_value(state).unwrap();
    assert_eq!(saved["since"], 504);
    assert_eq!(saved["last_id"], "latest");
    assert_eq!(saved["seen"].as_array().unwrap().len(), 500);
    assert_eq!(saved["seen"][0], "m-5");
    assert_eq!(saved["owner_state"], json!({"choice": 7}));
}

#[test]
fn polling_preserves_server_order_for_equal_timestamps_and_uses_the_address_policy() {
    let scope = Scope {
        direct: false,
        name: Some("Worker".into()),
        session: Some("me".into()),
    };
    let mut room: Room = serde_json::from_value(json!({"since":2, "seen":["seen"]})).unwrap();
    let rows = [
        message("third", 8, "other", true),
        message("first", 6, "other", true),
        message("below", 1, "other", true),
        message("second", 6, "me", true),
        message("seen", 9, "other", true),
        message("silent", 6, "other", false),
    ];
    assert_eq!(
        room.pending(&scope, &rows),
        [(1, true), (3, false), (5, false), (0, true)]
    );
    room.apply(Change::Skip {
        id: "silent".into(),
    })
    .unwrap();
    assert_eq!(
        room.pending(&scope, &rows),
        [(1, true), (3, false), (0, true)]
    );
}

#[test]
fn uncertain_claim_retries_once_and_requires_a_newer_post_from_the_same_session() {
    let mut room: Room = serde_json::from_value(json!({"since":1})).unwrap();
    for tries in 1..=2 {
        room.apply(Change::Claim {
            id: "source".into(),
            msg_at: 8.into(),
        })
        .unwrap();
        let saved = serde_json::to_value(&room).unwrap();
        let entry = &saved["claims"]["source"];
        assert_eq!(entry["tries"], tries);
        let claim: Claim = serde_json::from_value(entry.clone()).unwrap();
        let equivocal = [
            message("owner-same-time", 8, "me", false),
            message("foreign", 9, "other", false),
        ];
        let disposition = serde_json::to_value(claim.disposition("me", &equivocal)).unwrap();
        assert_eq!(
            disposition,
            if tries == 1 {
                Value::Null
            } else {
                json!("abandoned")
            }
        );
        let receipt = [message("posted", 9, "me", false)];
        assert_eq!(
            serde_json::to_value(claim.disposition("me", &receipt)).unwrap(),
            "settled"
        );
    }
    room.apply(Change::Complete {
        id: "source".into(),
    })
    .unwrap();
    room.apply(Change::Advance {
        latest: Some("source".into()),
    })
    .unwrap();
    let saved = serde_json::to_value(room).unwrap();
    assert_eq!(saved["claims"], json!({}));
    assert_eq!(saved["seen"], json!(["source"]));
    assert_eq!(saved["last_id"], "source");
}

#[test]
fn room_list_reads_joins_claims_and_new_ids_before_advancing_cached_rooms() {
    const JOINED: &str = "40000000-0000-4000-8000-000000000001";
    const STAYS: &str = "40000000-0000-4000-8000-000000000002";
    const GONE: &str = "40000000-0000-4000-8000-000000000003";
    let mut state = json!({
        "_auto_rooms":[STAYS,GONE],
        JOINED:{"since":1,"last_id":"same","claims":{}},
        STAYS:{"since":1,"last_id":"same","claims":{}},
    });
    let mut listed = [
        json!({"id":"malformed"}),
        json!({"id":JOINED,"kind":"dm","lastMessage":{"id":"same"}}),
        json!({"id":STAYS,"lastMessage":{"id":"same"}}),
    ];
    let before = rooms::reconcile(&listed, state.as_object().unwrap(), 1);
    assert_eq!(before["rooms"].as_array().unwrap().len(), 1);
    assert_eq!(before["rooms"][0]["read"], true);
    assert_eq!(before["total"], 2);

    let summary = rooms::reconcile(&listed, state.as_object().unwrap(), 2);
    assert_eq!(summary["joined"], json!([JOINED]));
    assert_eq!(summary["left"], 1);
    assert_eq!(summary["rooms"][0]["direct"], true);
    assert_eq!(summary["rooms"][1]["read"], false);
    state[STAYS]["claims"] = json!({"waiting":{"msg_at":1,"tries":1}});
    assert_eq!(
        rooms::reconcile(&listed, state.as_object().unwrap(), 2)["rooms"][1]["read"],
        true
    );
    state[STAYS]["claims"] = json!({});
    listed[2]["lastMessage"]["id"] = json!("new");
    assert_eq!(
        rooms::reconcile(&listed, state.as_object().unwrap(), 2)["rooms"][1]["read"],
        true
    );
}

#[test]
fn state_file_uses_a_private_adjacent_publication_and_preserves_json_order() {
    let mut entropy = [0; 16];
    getrandom::getrandom(&mut entropy).unwrap();
    let nonce = reverie_core::ids::NativeOperationId::from_random_bytes(entropy);
    let directory = std::env::temp_dir().join(format!("hands-poll-{}", nonce.as_str()));
    fs::create_dir(&directory).unwrap();
    let path = directory.join("state.json");
    assert_eq!(
        serde_json::to_value(file::load(&path).unwrap()).unwrap()["present"],
        false
    );
    let neighbor = directory.join("foreign.json");
    fs::write(&neighbor, b"keep").unwrap();
    symlink(&neighbor, directory.join("state.json.tmp")).unwrap();
    file::save(&path, br#"{"z":3,"a":1}"#).unwrap();
    file::save(&path, br#"{"z":4,"a":2}"#).unwrap();
    assert_eq!(fs::read(&neighbor).unwrap(), b"keep");
    assert_eq!(
        fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert_eq!(
        serde_json::to_string(&file::load(&path).unwrap()).unwrap(),
        r#"{"present":true,"value":{"z":4,"a":2}}"#
    );
    fs::remove_dir_all(directory).unwrap();
}
