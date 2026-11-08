//! Closed reply DATA only. These values never create an actual ROOT/Office
//! registration, cookie, native peer or authenticated resource operation.
use super::*;
const OFFICE: &str = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const NIL: &str = "00000000-0000-0000-0000-000000000000";
fn decoded(value: &Json) -> Result<CurrentResourceOwner> {
    let original = request(&claim());
    let frame = HumanFrame::decode(&serde_json::to_vec(value).unwrap()).map_err(frame_error)?;
    original.parse_owner_reply(&frame, &nonce())
}
#[test]
fn principal_is_required_closed_and_uses_nonnil_canonical_registration_ids() {
    let original = reply(&claim());
    let owner = decoded(&original).unwrap();
    assert_eq!(owner.principal().account_id(), EID);
    assert_eq!(owner.principal().person_id(), "owner");
    assert_eq!(owner.principal().session_epoch(), 0);
    let mut missing = original.clone();
    missing.as_object_mut().unwrap().remove("principal");
    assert!(decoded(&missing).is_err());
    for principal in [Json::Null, json!({}), json!("owner"), json!(true)] {
        let mut changed = original.clone();
        changed["principal"] = principal;
        assert!(decoded(&changed).is_err());
    }
    for (field, value) in [
        ("accountId", json!(NIL)),
        ("accountId", json!(OFFICE.to_uppercase())),
        ("accountId", json!("owner")),
        ("personId", json!(NIL)),
        ("personId", json!(OFFICE.to_uppercase())),
        ("personId", json!("OWNER")),
        ("extra", json!(false)),
    ] {
        let mut changed = original.clone();
        changed["principal"][field] = value;
        assert!(decoded(&changed).is_err(), "{field}");
    }
    let mut office = original;
    office["principal"]["personId"] = json!(OFFICE);
    assert_eq!(decoded(&office).unwrap().principal().person_id(), OFFICE);
}
#[test]
fn principal_epoch_accepts_only_exact_nonnegative_safe_json_integers() {
    let original = reply(&claim());
    for epoch in [0, 1, reverie_core::revision::JS_SAFE_MAX] {
        let mut changed = original.clone();
        changed["principal"]["sessionEpoch"] = json!(epoch);
        assert_eq!(
            decoded(&changed).unwrap().principal().session_epoch(),
            epoch
        );
    }
    for epoch in [
        json!(-1),
        json!(true),
        json!(false),
        json!(1.0),
        json!("1"),
        json!(null),
        json!(reverie_core::revision::JS_SAFE_MAX + 1),
    ] {
        let mut changed = original.clone();
        changed["principal"]["sessionEpoch"] = epoch;
        assert!(decoded(&changed).is_err());
    }
}
#[test]
fn repeated_owner_equality_includes_every_registration_incarnation_field() {
    let original = reply(&claim());
    let first = decoded(&original).unwrap();
    for (field, value) in [
        ("accountId", json!(RID)),
        ("personId", json!(OFFICE)),
        ("sessionEpoch", json!(1)),
    ] {
        let mut changed = original.clone();
        changed["principal"][field] = value;
        let current = decoded(&changed).unwrap();
        assert_eq!(first.owner(), current.owner());
        assert_eq!(first.scope_digest(), current.scope_digest());
        assert_eq!(first.expires_at_epoch_ms(), current.expires_at_epoch_ms());
        assert_ne!(first, current, "{field}");
    }
}
