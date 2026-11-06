use reverie_contracts::memory::{
    EmbeddingResponse, Memory, MemoryMetadata, MemorySources, encode_embedding_request,
};
use reverie_core::memory::{normalize, pack};
use serde_json::Value;
fn fixture() -> Value {
    serde_json::from_str(include_str!("fixtures/memory-python.json")).unwrap()
}
fn bytes(raw: &str) -> Vec<u8> {
    raw.as_bytes()
        .chunks_exact(2)
        .map(|p| u8::from_str_radix(std::str::from_utf8(p).unwrap(), 16).unwrap())
        .collect()
}
// These helpers compare results of normalization arithmetic, not stored data.
// Inf/Inf in the 1e999 fixture has no source NaN sign to preserve. Rust permits
// either NaN sign after arithmetic/casts; payload/quiet bits stay checked here.
// https://doc.rust-lang.org/std/primitive.f32.html#nan-bit-patterns
fn arithmetic_bits(value: f64) -> u64 {
    let bits = value.to_bits();
    if value.is_nan() {
        bits & !(1 << 63)
    } else {
        bits
    }
}
fn arithmetic_blob(raw: &[u8]) -> Vec<u8> {
    assert!(raw.len().is_multiple_of(4));
    raw.chunks_exact(4)
        .flat_map(|part| {
            let value = f32::from_ne_bytes(part.try_into().unwrap());
            let bits = value.to_bits();
            let bits = if value.is_nan() {
                bits & !(1 << 31)
            } else {
                bits
            };
            bits.to_ne_bytes()
        })
        .collect()
}
fn record(meta: MemoryMetadata) -> Memory {
    Memory {
        id: 1,
        kind: "dream".into(),
        created_at: 1000.0,
        user_text: String::new(),
        assistant_text: String::new(),
        text: "waking recall".into(),
        importance: 2.0,
        importance_source: "fixed".into(),
        embed_model: "hashed-v1-1".into(),
        embedding: Vec::new(),
        source_ids: MemorySources::new(&[]),
        section: String::new(),
        meta,
        last_accessed: None,
        score: 0.0,
    }
}
#[test]
fn actual_python_memory_fields_order_truthiness_recall_and_release_match() {
    let fixture = fixture();
    assert_eq!(fixture["metadata"].as_array().unwrap().len(), 18);
    for case in fixture["metadata"].as_array().unwrap() {
        let result = MemoryMetadata::decode(case["raw"].as_str().unwrap());
        assert_eq!(
            result.is_ok(),
            case["accepted"].as_bool().unwrap(),
            "{}",
            case["raw"]
        );
        if let Ok(meta) = result {
            assert_eq!(meta.json(), case["normalized"].as_str().unwrap());
            assert_eq!(
                meta.clone().or_empty().json(),
                case["orEmpty"].as_str().unwrap()
            );
            let memory = record(meta);
            assert_eq!(
                memory.as_dict_json(),
                case["asDictJson"].as_str().unwrap().as_bytes()
            );
            assert_eq!(memory.as_dict().as_json(), memory.as_dict_json());
            let idle = memory.is_idle();
            assert_eq!(idle.is_ok(), case["is_idleAccepted"].as_bool().unwrap());
            if let Ok(idle) = idle {
                assert_eq!(idle, case["is_idle"].as_bool().unwrap());
            }
            let recall = memory.recall();
            assert_eq!(recall.is_ok(), case["recallAccepted"].as_bool().unwrap());
            if let Ok(recall) = recall {
                assert_eq!(
                    recall.codepoints(),
                    case["recallPoints"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|v| v.as_u64().unwrap() as u32)
                        .collect::<Vec<_>>()
                );
            }
            let released = memory.meta.with_released(true);
            assert_eq!(released.is_ok(), case["releaseAccepted"].as_bool().unwrap());
            if let Ok(meta) = released {
                assert_eq!(meta.json(), case["released"].as_str().unwrap());
            }
        }
    }
}
#[test]
fn real_http_python_response_shape_dimensions_coercion_and_vector_bytes_match() {
    let fixture = fixture();
    assert_eq!(fixture["httpResponses"].as_array().unwrap().len(), 24);
    for case in fixture["httpResponses"].as_array().unwrap() {
        let decoded = EmbeddingResponse::decode(&bytes(case["rawHex"].as_str().unwrap()));
        match decoded {
            Err(_) => {
                assert!(!case["accepted"].as_bool().unwrap());
                assert_eq!(case["dims"], 0);
            }
            Ok(decoded) => {
                assert_eq!(
                    decoded.dimensions(),
                    case["dims"].as_u64().unwrap() as usize
                );
                let vector = decoded.vector().map(|v| normalize(&v));
                assert_eq!(vector.is_ok(), case["accepted"].as_bool().unwrap());
                if let Ok(vector) = vector {
                    assert_eq!(
                        vector
                            .iter()
                            .map(|v| arithmetic_bits(*v))
                            .collect::<Vec<_>>(),
                        case["bits"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .map(|v| arithmetic_bits(f64::from_bits(
                                u64::from_str_radix(v.as_str().unwrap(), 16).unwrap()
                            )))
                            .collect::<Vec<_>>()
                    );
                    assert_eq!(
                        arithmetic_blob(&pack(&vector)),
                        arithmetic_blob(&bytes(case["blob"].as_str().unwrap()))
                    );
                }
            }
        }
    }
    for expected in fixture["requestBodies"].as_array().unwrap() {
        assert_eq!(
            encode_embedding_request("search_document: synthetic", ""),
            expected.as_str().unwrap().as_bytes()
        );
    }
    assert_eq!(
        encode_embedding_request("custom: é", "model-😀"),
        br#"{"input": "custom: \u00e9", "model": "model-\ud83d\ude00"}"#
    );
}
#[test]
fn arithmetic_oracle_relaxes_only_nan_sign_and_keeps_every_other_bit() {
    assert_eq!(
        arithmetic_bits(f64::from_bits(0x7ff8_0000_0000_0000)),
        arithmetic_bits(f64::from_bits(0xfff8_0000_0000_0000))
    );
    for bits in [0, 1, 0x3ff0_0000_0000_0000, 0x7ff0_0000_0000_0000] {
        assert_eq!(arithmetic_bits(f64::from_bits(bits)), bits);
        assert_eq!(
            arithmetic_bits(f64::from_bits(bits | (1 << 63))),
            bits | (1 << 63)
        );
    }
    for payload in [1, 0x0001_0000_0000_0000] {
        assert_ne!(
            arithmetic_bits(f64::from_bits(0x7ff8_0000_0000_0000)),
            arithmetic_bits(f64::from_bits(0x7ff8_0000_0000_0000 | payload))
        );
    }
    assert_ne!(
        arithmetic_bits(f64::from_bits(0x7ff8_0000_0000_0000)),
        arithmetic_bits(f64::from_bits(0x7ff0_0000_0000_0001))
    );
    let blob = |bits: u32| bits.to_ne_bytes();
    assert_eq!(
        arithmetic_blob(&blob(0x7fc0_0000)),
        arithmetic_blob(&blob(0xffc0_0000))
    );
    for bits in [0, 1, 0x3f80_0000, 0x7f80_0000] {
        assert_eq!(arithmetic_blob(&blob(bits)), blob(bits));
        assert_eq!(
            arithmetic_blob(&blob(bits | (1 << 31))),
            blob(bits | (1 << 31))
        );
    }
    for bits in [0x7fc0_0001, 0x7fe0_0000, 0x7f80_0001] {
        assert_ne!(
            arithmetic_blob(&blob(0x7fc0_0000)),
            arithmetic_blob(&blob(bits))
        );
    }
}
#[test]
fn nested_replacement_and_surrogate_keys_keep_first_insertion_order() {
    for (raw, expected) in [
        (
            r#"{"z":{"x":1,"y":2},"a":0,"z":{"b":3,"a":4}}"#,
            r#"{"z": {"b": 3, "a": 4}, "a": 0, "released": true}"#,
        ),
        (
            r#"{"\ud800":1,"a":2,"\ud800":3}"#,
            r#"{"\ud800": 3, "a": 2, "released": true}"#,
        ),
        (
            r#"{"a":1,"\u0061":2,"b":3}"#,
            r#"{"a": 2, "b": 3, "released": true}"#,
        ),
    ] {
        assert_eq!(
            MemoryMetadata::decode(raw)
                .unwrap()
                .with_released(true)
                .unwrap()
                .json(),
            expected
        );
    }
}
#[test]
fn ordered_capture_clone_emit_and_drop_are_iterative() {
    let depth = 10_000;
    let raw = format!("{}0{}", "[".repeat(depth), "]".repeat(depth));
    let memory = MemoryMetadata::decode(&raw).unwrap();
    assert_eq!(memory.clone().json(), raw);
}
#[test]
fn source_iteration_preserves_python_width_order_and_surrogate_characters() {
    for (raw, expected) in [
        (
            r#"[9223372036854775808, {"x": 1}, null, true]"#,
            r#"[9223372036854775808, {"x": 1}, null, true]"#,
        ),
        (
            r#"{"z":0,"a":1,"z":2,"\ud800":3}"#,
            r#"["z", "a", "\ud800"]"#,
        ),
        (r#""A\ud800𝄞""#, r#"["A", "\ud800", "\ud834\udd1e"]"#),
    ] {
        assert_eq!(
            MemorySources::decode(raw)
                .unwrap()
                .iterated()
                .unwrap()
                .json(),
            expected
        );
    }
    for raw in ["null", "false", "12", "1.5"] {
        assert!(MemorySources::decode(raw).unwrap().iterated().is_err());
    }
}
