use super::*;

#[test]
fn named_journal_parse_hooks_do_not_change_existing_reader_policies() {
    let raw = br#"{"key":1,"key":2,"later":0.5}"#;
    assert_eq!(decode_utf8(raw).err(), Some(Error::DuplicateKey));
    assert_eq!(
        decode_bytes_without_constants(raw).err(),
        Some(Error::DuplicateKey)
    );
    assert!(decode_rootless_profile(raw).is_ok());
    assert_eq!(
        decode_journal(raw).err(),
        Some(JournalParseError::JsonNumber)
    );
    let long = format!(
        "{{\"key\":{},\"key\":1}}",
        "1".repeat(DEFAULT_INT_MAX_DIGITS + 1)
    );
    assert_eq!(
        decode_rootless_profile(long.as_bytes()).err(),
        Some(Error::InvalidJson)
    );
    assert_eq!(
        decode_utf8(long.as_bytes()).err(),
        Some(Error::DuplicateKey)
    );
    assert_eq!(
        decode_journal(long.as_bytes()).err(),
        Some(JournalParseError::DocumentInteger)
    );
    let one = format!("{{\"key\":{}}}", "1".repeat(DEFAULT_INT_MAX_DIGITS));
    assert!(decode_rootless_profile(one.as_bytes()).is_ok());
    assert!(
        decode_utf8(format!("{{\"key\":{}}}", "1".repeat(DEFAULT_INT_MAX_DIGITS + 1)).as_bytes())
            .is_ok()
    );
}
#[test]
fn merged_rootless_and_metadata_readers_keep_distinct_duplicate_and_shared_integer_rules() {
    let raw = br#"{"x":0,"x":1}"#;
    assert!(
        decode_rootless_profile(raw)
            .unwrap()
            .python_eq(&decode_utf8(br#"{"x":1}"#).unwrap())
    );
    assert_eq!(decode_metadata_bytes(raw).err(), Some(Error::DuplicateKey));
    for raw in [
        br#"{"x":0,"x":1,"later":[}"#.as_slice(),
        br#"[{"x":0,"x":1},{"later":[}]"#.as_slice(),
    ] {
        assert_eq!(decode_rootless_profile(raw).err(), Some(Error::InvalidJson));
    }
    for digits in [4300, 4301] {
        let raw = format!("{{\"opaque\":{},\"opaque\":0}}", "7".repeat(digits));
        assert_eq!(
            decode_rootless_profile(raw.as_bytes()).is_ok(),
            digits == 4300
        );
    }
    for raw in ["[NaN]", "Infinity", r#""\ud800""#] {
        let metadata = decode_metadata_bytes(raw.as_bytes()).unwrap();
        assert!(metadata.python_eq(&decode_rootless_profile(raw.as_bytes()).unwrap()));
        assert!(metadata.python_eq(&decode_rootless_profile(&utf16(raw, true, true)).unwrap()));
    }
}
#[test]
fn python_numeric_equality_preserves_exact_large_integer_comparison_and_nan_identity() {
    for (left, right, equal) in [
        ("true", "1", true),
        ("false", "-0.0", true),
        ("1", "1.0", true),
        ("1", "1.0000000000000002", false),
        ("1000000000000000019884624838656", "1e30", true),
        ("1000000000000000000000000000000", "1e30", false),
        ("9007199254740992", "9007199254740993.0", true),
        ("9007199254740993", "9007199254740993.0", false),
        ("NaN", "NaN", false),
        ("[NaN]", "[NaN]", true),
        ("{\"x\":NaN}", "{\"x\":NaN}", true),
        ("[NaN]", "[1]", false),
        ("Infinity", "1e9999", true),
        ("-Infinity", "Infinity", false),
        ("[1]", "[true]", true),
        ("[1]", "{\"0\":1}", false),
        ("\"1\"", "1", false),
        ("{\"a\":1,\"b\":2}", "{\"b\":2.0,\"a\":true}", true),
    ] {
        assert_eq!(
            decode_bytes(left.as_bytes())
                .unwrap()
                .python_eq(&decode_bytes(right.as_bytes()).unwrap()),
            equal,
            "{left} == {right}"
        );
    }
}
#[test]
fn python_byte_encoding_discriminators_include_two_byte_and_non_ascii_string_roots() {
    let integer = decode_bytes(b"1").unwrap();
    for raw in [&b"1\0"[..], &b"\x001"[..]] {
        assert!(decode_bytes(raw).unwrap().python_eq(&integer));
    }
    for text in ["\"中\"", "\"😀\"", "1", "{}"] {
        let expected = decode_bytes(text.as_bytes()).unwrap();
        for (little, bom) in [(true, true), (false, true), (true, false), (false, false)] {
            assert!(
                decode_bytes(&utf16(text, little, bom))
                    .unwrap()
                    .python_eq(&expected)
            );
        }
    }
    for raw in [
        &b"\"\xed\xa0\x80\""[..],
        &b"\"\0\0\xd8\"\0"[..],
        &b"\0\"\xd8\0\0\""[..],
        &b"\"\0\0\0\0\xd8\0\0\"\0\0\0"[..],
    ] {
        assert!(
            decode_bytes(raw)
                .unwrap()
                .python_eq(&decode_bytes(br#""\ud800""#).unwrap())
        );
    }
}
fn utf16(text: &str, little: bool, bom: bool) -> Vec<u8> {
    let mut raw = match (little, bom) {
        (true, true) => vec![0xff, 0xfe],
        (false, true) => vec![0xfe, 0xff],
        _ => vec![],
    };
    for unit in text.encode_utf16() {
        raw.extend(if little {
            unit.to_le_bytes()
        } else {
            unit.to_be_bytes()
        });
    }
    raw
}
#[test]
fn strict_engine_hooks_are_isolated_from_existing_purposes() {
    use super::*;
    assert!(decode_engine_inventory(br#"{"x":0,"x":1}"#).is_ok());
    assert_eq!(
        decode_engine_stopped(br#"{"x":0,"x":1}"#).err(),
        Some(Error::DuplicateKey)
    );
    assert!(decode_engine_stopped(br#"{"unused":1e309}"#).is_ok());
    assert!(decode_engine_stopped(br#"{"unused":NaN}"#).is_err());
    let raw = format!("{{\"unused\":{}}}", "1".repeat(4301));
    assert!(decode_engine_stopped(raw.as_bytes()).is_err());
    assert!(decode_bytes_without_constants(raw.as_bytes()).is_ok());
    assert!(decode_engine_inventory(b"\xef\xbb\xbf{}").is_err());
    assert!(decode_rootless_profile(b"\xef\xbb\xbf{}").is_ok());
}
#[test]
fn metadata_hooks_do_not_change_existing_hash_data_or_default_byte_mode() {
    let raw = format!("{{\"opaque\":{}}}", "7".repeat(4301));
    assert!(decode_utf8(raw.as_bytes()).is_ok());
    assert!(decode_bytes(raw.as_bytes()).is_ok());
    assert_eq!(
        decode_metadata_bytes(raw.as_bytes()).err(),
        Some(Error::InvalidJson)
    );
    let raw = br#"{"x":0,"x":1,"later":[}"#;
    assert_eq!(decode_utf8(raw).err(), Some(Error::DuplicateKey));
    assert_eq!(decode_bytes(raw).err(), Some(Error::DuplicateKey));
    assert_eq!(decode_metadata_bytes(raw).err(), Some(Error::InvalidJson));
    assert_eq!(
        decode_metadata_bytes(br#"[{"x":0,"x":1},{"later":[}]"#).err(),
        Some(Error::DuplicateKey)
    );
}
// The old general bytes purpose has no production consumer after fixed perf
// readers adopt metadata hooks. Keep its isolation controls local to tests.
fn decode_bytes(raw: &[u8]) -> Result<Value, Error> {
    decode::decode(&text::python_bytes(raw)?)
}
