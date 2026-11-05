use reverie_contracts::storage_identity::{IdentityDataError, MetadataText, decode_metadata};
use reverie_core::ids::{ProfileEmployeeId, ProfileSessionId};
use serde_json::json;
const E: &str = "11111111-2222-4333-8444-555555555555";
const A: &str = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
fn sid() -> ProfileSessionId {
    ProfileSessionId::parse(A).unwrap()
}
fn eid() -> ProfileEmployeeId {
    ProfileEmployeeId::parse(E).unwrap()
}
fn records(raw: &str) -> Result<usize, IdentityDataError> {
    Ok(decode_metadata(raw.as_bytes())?
        .company_records()?
        .records()
        .len())
}

#[test]
fn unrelated_ids_and_sessions_remain_opaque_but_duplicates_use_python_scalar_equality() {
    assert_eq!(
        records(
            r#"{"employees":[{"id":"force-synthetic","sessionId":7},{"id":"\ud800","sessionId":null}]}"#
        ),
        Ok(2)
    );
    for pair in [
        "1,1.0",
        "true,1",
        "false,-0.0",
        "1e30,1000000000000000019884624838656",
        "NaN,NaN",
        "Infinity,1e9999",
    ] {
        let pair: Vec<_> = pair.split(',').collect();
        let raw = format!(
            "{{\"employees\":[{{\"id\":\"a\",\"sessionId\":{}}},{{\"id\":\"b\",\"sessionId\":{}}}]}}",
            pair[0], pair[1]
        );
        assert_eq!(
            records(&raw),
            Err(IdentityDataError::AmbiguousRegistry),
            "{raw}"
        );
    }
    for raw in [
        r#"{"employees":[{"id":"a"},{"id":"\u0061"}]}"#,
        r#"{"employees":[{"id":"a","sessionId":[]}] }"#,
    ] {
        assert_eq!(records(raw), Err(IdentityDataError::AmbiguousRegistry));
    }
    assert_eq!(
        records(r#"{"employees":[{"id":"a","sessionId":1},{"id":"b","sessionId":"1"}]}"#),
        Ok(2)
    );
}
#[test]
fn registry_shape_count_and_python_owner_codepoint_bounds_are_checked() {
    for raw in [
        "{}",
        r#"{"employees":null}"#,
        r#"{"employees":[],"retired":null}"#,
        r#"{"employees":[null]}"#,
    ] {
        assert!(records(raw).is_err());
    }
    let rows: Vec<_> = (0..10000)
        .map(|index| json!({"id":format!("opaque-{index}")}))
        .collect();
    assert_eq!(records(&json!({"employees":rows}).to_string()), Ok(10000));
    assert_eq!(
        records(&json!({"employees":rows,"retired":[{"id":"extra"}]}).to_string()),
        Err(IdentityDataError::RegistryBound)
    );
    for length in [200, 201] {
        let raw = json!({"employees":[{"id":"opaque","owner":"😀".repeat(length)}]}).to_string();
        assert_eq!(records(&raw).is_ok(), length == 200);
    }
    assert_eq!(
        records(r#"{"employees":[{"id":"a","owner":false}]}"#),
        Err(IdentityDataError::Owner)
    );
}
#[test]
fn named_views_validate_only_their_legacy_selected_fields() {
    let owner = Some(MetadataText::from_scalar_text("owner-a"));
    for generation in [
        "9007199254740992",
        "99999999999999999999999999999999999999999999999999",
    ] {
        let raw = format!(
            "{{\"employees\":[{{\"id\":\"{E}\",\"sessionId\":\"{A}\",\"owner\":\"owner-a\",\"sessionGeneration\":{generation}}},null]}}"
        );
        let metadata = decode_metadata(raw.as_bytes()).unwrap();
        assert_eq!(
            metadata
                .current_employee(&eid(), &sid(), &owner)
                .unwrap()
                .unwrap()
                .generation()
                .decimal(),
            generation
        );
        assert!(
            metadata
                .current_start_allowed(&eid(), &sid(), &owner)
                .is_err()
        );
    }
    for generation in ["true", "1.0", "0", "-1", "null"] {
        let raw = format!(
            "{{\"employees\":[{{\"id\":\"{E}\",\"sessionId\":\"{A}\",\"sessionGeneration\":{generation}}}]}}"
        );
        assert_eq!(
            decode_metadata(raw.as_bytes())
                .unwrap()
                .current_employee(&eid(), &sid(), &None),
            Err(IdentityDataError::CurrentGeneration)
        );
    }
    for version in ["true", "1", "1.0"] {
        let raw = format!(
            "{{\"version\":{version},\"employeeId\":\"{E}\",\"sessionId\":\"{A}\",\"owner\":null}}"
        );
        assert_eq!(
            decode_metadata(raw.as_bytes())
                .unwrap()
                .storage_owner(&sid())
                .unwrap()
                .employee(),
            &eid()
        );
    }
}
#[test]
fn metadata_byte_reading_preserves_python_surrogatepass_and_duplicate_refusal() {
    let escaped = br#"{"employees":[{"id":"opaque","owner":"\ud800"}]}"#;
    let expected = decode_metadata(escaped).unwrap().company_records().unwrap();
    let owner = expected.records()[0].owner().as_ref().unwrap();
    assert_eq!(owner.codepoints(), &[0xd800]);
    assert_eq!(owner.scalar_text(), None);
    let mut raw = br#"{"employees":[{"id":"opaque","owner":""#.to_vec();
    raw.extend([0xed, 0xa0, 0x80]);
    raw.extend(br#""}]}"#);
    assert_eq!(
        decode_metadata(&raw).unwrap().company_records().unwrap(),
        expected
    );
    for (little, width) in [(true, 2), (false, 2), (true, 4), (false, 4)] {
        assert_eq!(
            decode_metadata(&encoded(escaped, little, width))
                .unwrap()
                .company_records()
                .unwrap(),
            expected
        );
    }
    assert!(matches!(
        decode_metadata(br#"{"employees":[],"employees":[]}"#),
        Err(IdentityDataError::DuplicateKey)
    ));
    assert!(decode_metadata(b"{\"x\":\"\\\xed\xa0\x80\"}").is_err());
}
fn encoded(raw: &[u8], little: bool, width: usize) -> Vec<u8> {
    let mut bytes = match (little, width) {
        (true, 2) => vec![0xff, 0xfe],
        (false, 2) => vec![0xfe, 0xff],
        (true, _) => vec![0xff, 0xfe, 0, 0],
        (false, _) => vec![0, 0, 0xfe, 0xff],
    };
    for &byte in raw {
        let value = u32::from(byte);
        if width == 2 {
            bytes.extend(if little {
                (value as u16).to_le_bytes()
            } else {
                (value as u16).to_be_bytes()
            });
        } else {
            bytes.extend(if little {
                value.to_le_bytes()
            } else {
                value.to_be_bytes()
            });
        }
    }
    bytes
}
