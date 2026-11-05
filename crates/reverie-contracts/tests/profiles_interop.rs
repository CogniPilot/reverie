use reverie_contracts::profiles_v1::{self, CodecError, MAX_BYTES};
use reverie_core::ids::{NativeOperationId, ProfileEmployeeId};
use reverie_core::resources::CpuRepresentation;
use serde::Deserialize;
use serde_json::Value;
use serde_json::value::RawValue;
use std::collections::BTreeMap;

const EID: &str = "11111111-1111-4111-8111-111111111111";
const FLOATS: &str = include_str!("fixtures/valid-cpu-floats.json");
const LEGACY: &str = include_str!("fixtures/legacy-python-interop.json");

fn wrap(profile: &str) -> String {
    format!(
        "{{\"profiles\":{{\"{EID}\":{profile}}},\"revision\":0,\"schema\":\"reverie-employee-resource-profiles-v1\"}}"
    )
}
fn profile(cpu: &str) -> String {
    format!(
        "{{\"binding\":{{\"current_generation\":1,\"current_sid\":\"22222222-2222-4222-8222-222222222222\",\"employee_id\":\"{EID}\",\"target_generation\":2,\"target_sid\":\"33333333-3333-4333-8333-333333333333\"}},\"resources\":{{\"budgetMode\":\"admission\",\"cpus\":{cpu},\"memoryMiB\":4096,\"pidsLimit\":512,\"poolMemoryMiB\":8192,\"poolTasksMax\":8192}},\"version\":1}}"
    )
}
fn bytes_from_hex(value: &str) -> Vec<u8> {
    value
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
        .collect()
}

fn corpus() -> BTreeMap<String, Box<RawValue>> {
    // Generic legacy evidence includes lone UTF-16 surrogates, which Rust String
    // intentionally cannot model. Select only this codec's actual profile rows.
    serde_json::from_str(LEGACY).unwrap()
}
fn profile_cases(corpus: &BTreeMap<String, Box<RawValue>>) -> Vec<Value> {
    let rows: Vec<Box<RawValue>> = serde_json::from_str(corpus["cases"].get()).unwrap();
    rows.into_iter()
        .filter_map(|row| {
            let fields: BTreeMap<String, Box<RawValue>> = serde_json::from_str(row.get()).unwrap();
            let kind: String = serde_json::from_str(fields["kind"].get()).unwrap();
            (kind == "profile").then(|| serde_json::from_str(row.get()).unwrap())
        })
        .collect()
}

#[test]
fn actual_legacy_profile_vectors_match_validation_bytes_and_digest() {
    let corpus = corpus();
    assert_eq!(
        serde_json::from_str::<String>(corpus["source_head"].get()).unwrap(),
        "0cc46ab8de6d0ae981c618e40fb00ed03b897b02"
    );
    let mut checked = 0;
    for case in profile_cases(&corpus) {
        checked += 1;
        let raw = String::from_utf8(bytes_from_hex(case["raw_hex"].as_str().unwrap())).unwrap();
        let document = profiles_v1::decode(wrap(&raw).as_bytes());
        let valid = case["profile_validator"]["ok"].as_bool().unwrap();
        assert_eq!(document.is_ok(), valid, "{}", case["name"]);
        if let Ok(document) = document {
            let value = document.profiles().values().next().unwrap();
            assert_eq!(
                profiles_v1::encode_profile(value).unwrap(),
                case["profile_encode"]["value"]["text"]
                    .as_str()
                    .unwrap()
                    .as_bytes()
            );
            assert_eq!(
                profiles_v1::profile_digest(value).unwrap().to_hex(),
                case["profile_encode"]["value"]["sha256"].as_str().unwrap()
            );
        }
    }
    assert!(checked >= 14);
    let empty = profiles_v1::decode(
        br#"{"schema":"reverie-employee-resource-profiles-v1","revision":0,"profiles":{}}"#,
    )
    .unwrap();
    assert_eq!(
        profiles_v1::document_digest(&empty).unwrap().to_hex(),
        "e06493b800d476920535404de1678d7a8b4594e297416cb1e51518651f68c448"
    );
}

#[derive(Deserialize)]
struct FloatReference {
    name: String,
    raw: String,
    f64_bits: String,
}
#[test]
fn five_hundred_actual_python_float_witnesses_preserve_bits_and_bytes() {
    let references: Vec<FloatReference> = serde_json::from_str(FLOATS).unwrap();
    assert_eq!(references.len(), 500);
    for reference in references {
        let token = reference
            .raw
            .strip_prefix("{\"cpus\":")
            .unwrap()
            .strip_suffix('}')
            .unwrap();
        let expected = profile(token);
        let document = profiles_v1::decode(wrap(&expected).as_bytes()).unwrap();
        let value = document.profiles().values().next().unwrap();
        let CpuRepresentation::Float(number) = value.resources().cpus().representation() else {
            panic!("lost float kind");
        };
        assert_eq!(
            format!("{:016x}", number.to_bits()),
            reference.f64_bits,
            "{}",
            reference.name
        );
        assert_eq!(
            profiles_v1::encode_profile(value).unwrap(),
            expected.as_bytes(),
            "{}",
            reference.name
        );
    }
}

#[test]
fn cpu_integer_and_float_lexical_variants_match_python_kind_and_negative_zero() {
    for (input, output) in [
        ("-0", "0"),
        ("0", "0"),
        ("0.0", "0.0"),
        ("-0.0", "-0.0"),
        ("1e0", "1.0"),
        ("64", "64"),
        ("64.0", "64.0"),
    ] {
        let document = profiles_v1::decode(wrap(&profile(input)).as_bytes()).unwrap();
        assert_eq!(
            profiles_v1::encode_profile(document.profiles().values().next().unwrap()).unwrap(),
            profile(output).as_bytes()
        );
    }
}

#[test]
fn integer_negative_zero_is_not_confused_with_float_zero_in_other_fields() {
    let source = wrap(&profile("0"))
        .replace("\"revision\":0", "\"revision\":-0")
        .replace("\"admission\"", "\"pool\"")
        .replace("\"memoryMiB\":4096", "\"memoryMiB\":-0");
    let document = profiles_v1::decode(source.as_bytes()).unwrap();
    assert_eq!(document.revision().get(), 0);
    assert_eq!(
        document
            .profiles()
            .values()
            .next()
            .unwrap()
            .resources()
            .memory_mib(),
        0
    );
    assert!(
        profiles_v1::decode(
            source
                .replace("\"revision\":-0", "\"revision\":0.0")
                .as_bytes()
        )
        .is_err()
    );
}

#[test]
fn domain_identity_vectors_preserve_nil_differences() {
    let corpus = corpus();
    let domain: Value = serde_json::from_str(corpus["domain_checks"].get()).unwrap();
    for (id, expected) in domain["uuid"].as_object().unwrap() {
        assert_eq!(
            ProfileEmployeeId::parse(id).is_ok(),
            expected["profile_uid"]["ok"].as_bool().unwrap()
        );
        assert_eq!(
            NativeOperationId::parse(id).is_ok(),
            expected["operation_uuid"]["ok"].as_bool().unwrap()
        );
    }
    let nil = "00000000-0000-0000-0000-000000000000";
    let raw = wrap(&profile("0"))
        .replace(EID, nil)
        .replace("22222222-2222-4222-8222-222222222222", nil)
        .replace("33333333-3333-4333-8333-333333333333", nil);
    assert!(profiles_v1::decode(raw.as_bytes()).is_ok());
}

#[test]
fn rejects_duplicate_and_escaped_duplicate_keys_at_every_schema_level() {
    let original = wrap(&profile("0"));
    for raw in [
        original.replacen("\"revision\":0", "\"revision\":0,\"revision\":0", 1),
        original.replacen("\"version\":1", "\"version\":1,\"version\":1", 1),
        original.replacen("\"cpus\":0", "\"cpus\":0,\"cpus\":0", 1),
        original.replacen(
            "\"current_generation\":1",
            "\"current_generation\":1,\"current_generation\":1",
            1,
        ),
        original.replacen("\"cpus\":0", "\"cpus\":0,\"\\u0063pus\":1", 1),
        format!(
            "{{\"schema\":\"reverie-employee-resource-profiles-v1\",\"revision\":0,\"profiles\":{{\"{EID}\":{},\"{EID}\":{}}}}}",
            profile("0"),
            profile("1")
        ),
    ] {
        assert_eq!(
            profiles_v1::decode(raw.as_bytes()).unwrap_err(),
            CodecError::DuplicateKey
        );
    }
}

#[test]
fn refuses_extra_fields_nonfinite_cpu_invalid_bindings_and_counter_types() {
    let original = wrap(&profile("0"));
    for raw in [
        original.replacen("\"revision\":0", "\"revision\":0,\"extra\":true", 1),
        original.replacen("\"revision\":0", "\"revision\":true", 1),
        original.replacen("\"revision\":0", "\"revision\":0.0", 1),
        original.replacen("\"version\":1", "\"version\":0", 1),
        original.replacen("\"target_generation\":2", "\"target_generation\":0", 1),
        original.replacen("\"revision\":0", "\"revision\":9007199254740992", 1),
        wrap(&profile("NaN")),
        wrap(&profile("1e999")),
        wrap(&profile("0.1")),
        original.replacen("\"employee_id\":\"1111", "\"employee_id\":\"2111", 1),
    ] {
        assert!(profiles_v1::decode(raw.as_bytes()).is_err());
    }
    assert_eq!(
        profiles_v1::decode(&vec![b' '; MAX_BYTES + 1]).unwrap_err(),
        CodecError::StoreBound
    );
}

#[test]
fn legacy_byte_encodings_decode_then_write_the_same_canonical_ascii() {
    let raw = wrap(&profile("1.0"));
    let expected = profiles_v1::encode(&profiles_v1::decode(raw.as_bytes()).unwrap()).unwrap();
    let mut variants = vec![[vec![0xef, 0xbb, 0xbf], raw.as_bytes().to_vec()].concat()];
    for little in [true, false] {
        let utf16: Vec<u8> = raw
            .encode_utf16()
            .flat_map(|unit| {
                if little {
                    unit.to_le_bytes()
                } else {
                    unit.to_be_bytes()
                }
            })
            .collect();
        let utf32: Vec<u8> = raw
            .chars()
            .flat_map(|character| {
                if little {
                    u32::from(character).to_le_bytes()
                } else {
                    u32::from(character).to_be_bytes()
                }
            })
            .collect();
        variants.push(utf16.clone());
        variants.push(utf32.clone());
        variants.push(
            [
                if little {
                    vec![0xff, 0xfe]
                } else {
                    vec![0xfe, 0xff]
                },
                utf16,
            ]
            .concat(),
        );
        variants.push(
            [
                if little {
                    vec![0xff, 0xfe, 0, 0]
                } else {
                    vec![0, 0, 0xfe, 0xff]
                },
                utf32,
            ]
            .concat(),
        );
    }
    for variant in variants {
        assert_eq!(
            profiles_v1::encode(&profiles_v1::decode(&variant).unwrap()).unwrap(),
            expected
        );
    }
}
