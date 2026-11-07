//! Real unchanged Python prepare/finish wire witnesses, including the original
//! adjacent-surrogate json.loads distinction. DATA codecs confer no ownership.
use reverie_contracts::{storage_identity::MetadataText, worker_cold_tmp::*};
use reverie_core::{
    PythonText,
    decimal::UnsignedInteger,
    ids::{ContainerId, NativeOperationId, ProfileSessionId},
    posix_path::PosixPath,
};
use serde_json::Value;
fn points(value: &Value) -> Vec<u32> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|value| u32::try_from(value.as_u64().unwrap()).unwrap())
        .collect()
}
fn text<'a>(row: &'a Value, name: &str) -> &'a str {
    row[name].as_str().unwrap()
}
fn key(row: &Value, name: &str) -> (u64, u64) {
    (
        row[name][0].as_u64().unwrap(),
        row[name][1].as_u64().unwrap(),
    )
}
fn path(value: &str) -> PosixPath {
    PosixPath::try_new(&value.chars().map(u32::from).collect::<Vec<_>>()).unwrap()
}
fn wire(raw: Vec<u8>, row: &Value, name: &str) {
    assert_eq!(
        String::from_utf8(raw).unwrap(),
        text(row, name),
        "{} {name}",
        text(row, "case")
    );
}
#[test]
fn original_six_owner_forms_match_every_prepared_bound_and_lease_byte() {
    let rows: Vec<Value> = serde_json::from_str(include_str!(
        "fixtures/worker-cold-retained-records-python.json"
    ))
    .unwrap();
    assert_eq!(rows.len(), 6);
    for row in rows {
        check(&row);
    }
}
#[test]
fn original_thirty_canonical_confirmation_shapes_match_header_and_mount_refusal() {
    let rows: Vec<Value> = serde_json::from_str(include_str!(
        "fixtures/worker-cold-retained-confirmation-python.json"
    ))
    .unwrap();
    assert_eq!(rows.len(), 30);
    for row in rows {
        let source =
            reverie_contracts::worker_config::decode(&serde_json::to_vec(&row["source"]).unwrap())
                .unwrap();
        let cid = ContainerId::parse(text(&row, "cid")).unwrap();
        let sid = ProfileSessionId::parse(text(&row, "session")).unwrap();
        let target = MetadataText::from_scalar_text(text(&row, "target"));
        let result = RetainedInspection::decode(
            text(&row, "raw").as_bytes(),
            &cid,
            &source,
            &sid,
            Some(text(&row, "employee")),
        )
        .and_then(|inspection| {
            inspection.require_tmp_bind(&target)?;
            let repeated = RetainedInspection::decode(
                text(&row, "raw").as_bytes(),
                &cid,
                &source,
                &sid,
                Some(text(&row, "employee")),
            )?;
            assert!(inspection.same_observation(&repeated).unwrap());
            Ok(())
        });
        assert_eq!(
            result.is_ok(),
            row["accepted"].as_bool().unwrap(),
            "{}: {:?}",
            text(&row, "case"),
            row["sourceError"]
        );
    }
}
fn check(row: &Value) {
    let attempt = NativeOperationId::parse(text(row, "attempt")).unwrap();
    let session = ProfileSessionId::parse(text(row, "session")).unwrap();
    let owner = (!row["owner"].is_null()).then(|| {
        MetadataText::from_python_text(PythonText::try_new(points(&row["owner"])).unwrap())
    });
    let identity = RetainedRecordIdentity {
        attempt: &attempt,
        identity: text(row, "identity"),
        session: &session,
        owner: owner.as_ref(),
    };
    let envelope = path(text(row, "envelope"));
    let epoch = RetainedRecordEpoch {
        identity,
        envelope: &envelope,
        old: key(row, "old"),
    };
    let reservation = RetainedLeaseRecord::decode(text(row, "reservationRecord").as_bytes())
        .unwrap()
        .reservation_until()
        .unwrap();
    let fresh = RetainedRecordFresh {
        epoch,
        new: key(row, "new"),
        reservation_until: &reservation,
    };
    let before = ReferenceReport::default();
    let after = ReferenceReport::default();
    wire(retained_keep_record(), row, "keep");
    wire(
        retained_intent_record(epoch, &before, text(row, "configDigest")),
        row,
        "intent",
    );
    wire(
        retained_prepared_record(fresh, &before, &after),
        row,
        "prepared",
    );
    assert_eq!(
        retained_prepared_binding(
            text(row, "prepared").as_bytes(),
            identity.identity,
            &session,
            owner.as_ref()
        )
        .is_ok(),
        row["finishAccepted"].as_bool().unwrap(),
        "{}",
        text(row, "case")
    );
    let original: Value = serde_json::from_str(text(row, "pathRecord")).unwrap();
    wire(
        retained_path_record(&envelope, original["first_seen_utc"].as_f64().unwrap()),
        row,
        "pathRecord",
    );
    let original: Value = serde_json::from_str(text(row, "reservationRecord")).unwrap();
    wire(
        retained_reservation_record(&envelope, original["created_utc"].as_f64().unwrap()),
        row,
        "reservationRecord",
    );
    if row["finishAccepted"].as_bool().unwrap() {
        let cid = ContainerId::parse(text(&row["native"], "containerId")).unwrap();
        let image = MetadataText::from_scalar_text(text(&row["native"], "image"));
        let pid = UnsignedInteger::from_u64(row["native"]["pid"].as_u64().unwrap());
        let native = RetainedNativeRecord {
            container: &cid,
            image: &image,
            pid: &pid,
            start: text(&row["native"], "startTick"),
        };
        wire(
            retained_bound_record(fresh, &before, &after, [&before, &after], native),
            row,
            "bound",
        );
    }
}
