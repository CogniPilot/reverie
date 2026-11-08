use super::*;
use reverie_core::operations::{JournalDigest, JournalId};
fn transition(
    raw: &[u8],
    old: &WorkerImageId,
    new: WorkerImageId,
) -> Result<ImagePinTransition, ImageDataError> {
    ImagePinTransition::prepare(
        raw,
        old,
        new,
        JournalId::parse("10000000-0000-4000-8000-000000000001").unwrap(),
        JournalDigest::parse(&"c".repeat(64)).unwrap(),
    )
}

fn image(digit: char) -> WorkerImageId {
    WorkerImageId::parse(&format!("sha256:{}", digit.to_string().repeat(64))).unwrap()
}

#[test]
fn image_edit_preserves_every_nonimage_byte_including_escaped_key_and_nested_pin() {
    let old = image('a');
    let new = image('b');
    let source=concat!(r#"{ "nested" : {"image": "$OLD"}, "im\u0061ge" : "$OLD", "text": "caf\u00e9\ud800", "number": 1.00e+00 }"#,"\r\n").replace("$OLD",old.as_str());
    let edit = transition(source.as_bytes(), &old, new.clone()).unwrap();
    let expected = source.replace(
        &format!(r#""im\u0061ge" : "{}""#, old.as_str()),
        &format!(r#""im\u0061ge" : "{}""#, new.as_str()),
    );
    assert_eq!(edit.configuration_bytes(), expected.as_bytes());
    assert_eq!(edit.before_bytes(), source.as_bytes());
    assert_eq!(edit.old_image(), &old);
    assert_eq!(edit.new_image(), &new);
    assert_ne!(edit.before_digest(), edit.after_digest());
}

#[test]
fn image_edit_refuses_foreign_old_pin_ambiguous_keys_and_nonimage_sources() {
    let old = image('a');
    let new = image('b');
    for raw in [
        format!(
            r#"{{"image":"{}","im\u0061ge":"{}"}}"#,
            old.as_str(),
            old.as_str()
        ),
        format!(r#"{{"image":"{}","nested":{{"x":1,"x":2}}}}"#, old.as_str()),
        format!(r#"{{"image":"{}"}} trailing"#, old.as_str()),
        format!(r#"[{{"image":"{}"}}]"#, old.as_str()),
        r#"{"image":true}"#.to_owned(),
        r#"{"other":"image"}"#.to_owned(),
    ] {
        assert!(transition(raw.as_bytes(), &old, new.clone()).is_err());
    }
    let raw = format!(r#"{{"image":"{}"}}"#, old.as_str());
    assert!(transition(raw.as_bytes(), &new, old.clone()).is_err());
    assert!(transition(raw.as_bytes(), &old, old.clone()).is_err());
}

#[test]
fn exact_image_ids_reject_tags_short_ids_and_noncanonical_digests() {
    for raw in [
        "latest",
        "reverie:latest",
        "sha256:a",
        &format!("sha256:{}", "A".repeat(64)),
        &format!("sha256:{}", "g".repeat(64)),
    ] {
        assert!(WorkerImageId::parse(raw).is_err());
    }
    assert_eq!(image('a').as_str(), format!("sha256:{}", "a".repeat(64)));
}

#[test]
fn pending_data_binds_original_operation_preview_and_exact_integer_version() {
    let old = image('a');
    let new = image('b');
    let raw = format!(r#"{{"image":"{}"}}"#, old.as_str());
    let intent = transition(raw.as_bytes(), &old, new).unwrap();
    let original = crate::storage_identity::decode_ordered_metadata(intent.bytes()).unwrap();
    assert!(intent.matches_metadata(&original));
    let value: serde_json::Value = serde_json::from_slice(intent.bytes()).unwrap();
    for (key, replacement) in [
        ("version", serde_json::json!(true)),
        ("version", serde_json::json!(1.0)),
        ("purpose", serde_json::json!("resource-ram-pool-v2")),
        (
            "operationId",
            serde_json::json!("10000000-0000-4000-8000-000000000002"),
        ),
        ("previewDigest", serde_json::json!("d".repeat(64))),
        ("extra", serde_json::json!(null)),
    ] {
        let mut changed = value.clone();
        changed[key] = replacement;
        let changed = crate::storage_identity::decode_ordered_metadata(
            &serde_json::to_vec(&changed).unwrap(),
        )
        .unwrap();
        assert!(!intent.matches_metadata(&changed), "{key}");
    }
}
