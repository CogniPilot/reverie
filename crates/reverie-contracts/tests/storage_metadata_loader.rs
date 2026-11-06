//! Actual worker_storage.read_metadata parse-hook boundaries used by the gate.
use reverie_contracts::storage_identity::decode_metadata;
use serde::Deserialize;
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    name: String,
    raw_hex: String,
    error: Option<String>,
}
#[test]
fn actual_owned_python_metadata_reads_match_all_purpose_vectors() {
    let cases: Vec<Case> =
        serde_json::from_str(include_str!("fixtures/storage-metadata-python.json")).unwrap();
    assert_eq!(cases.len(), 27);
    for case in cases {
        let raw = case
            .raw_hex
            .as_bytes()
            .chunks_exact(2)
            .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            decode_metadata(&raw).err().map(|error| error.code()),
            case.error.as_deref(),
            "{}",
            case.name
        );
    }
}

#[test]
fn metadata_raw_integers_keep_the_existing_python_conversion_bound() {
    let raw = |digits: usize| format!("{{\"opaque\":{}}}", "7".repeat(digits));
    assert!(decode_metadata(raw(4300).as_bytes()).is_ok());
    assert_eq!(
        decode_metadata(raw(4301).as_bytes())
            .err()
            .map(|error| error.code()),
        Some("METADATA_JSON")
    );
}
#[test]
fn metadata_duplicate_hook_runs_after_the_entire_object_is_decoded() {
    assert_eq!(
        decode_metadata(br#"{"x":0,"x":1,"y":[}"#)
            .err()
            .map(|error| error.code()),
        Some("METADATA_JSON")
    );
    assert_eq!(
        decode_metadata(br#"{"x":0,"x":[}"#)
            .err()
            .map(|error| error.code()),
        Some("METADATA_JSON")
    );
    assert_eq!(
        decode_metadata(br#"{"x":0,"x":1}"#)
            .err()
            .map(|error| error.code()),
        Some("DUPLICATE_KEY")
    );
}
#[test]
fn metadata_still_accepts_literal_nonfinite_and_legacy_byte_encodings() {
    assert!(decode_metadata(br#"{"opaque":[NaN,Infinity,-Infinity,1e309]}"#).is_ok());
    let raw = "{\"opaque\":1}"
        .encode_utf16()
        .flat_map(u16::to_le_bytes)
        .collect::<Vec<_>>();
    assert!(decode_metadata(&raw).is_ok());
}
