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
                            .map(|v| format!("{:016x}", v.to_bits()))
                            .collect::<Vec<_>>(),
                        case["bits"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .map(|v| v.as_str().unwrap())
                            .collect::<Vec<_>>()
                    );
                    assert_eq!(pack(&vector), bytes(case["blob"].as_str().unwrap()));
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
