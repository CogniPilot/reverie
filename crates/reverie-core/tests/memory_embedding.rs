use reverie_core::memory::{self, Embedder, EmbeddingKind, HashedEmbedder};
use serde_json::Value;
fn fixture() -> Value {
    serde_json::from_str(include_str!("fixtures/memory-embedding-python.json")).unwrap()
}
fn bytes(raw: &str) -> Vec<u8> {
    raw.as_bytes()
        .chunks_exact(2)
        .map(|p| u8::from_str_radix(std::str::from_utf8(p).unwrap(), 16).unwrap())
        .collect()
}
#[test]
fn actual_python_tokens_normalized_bits_and_persisted_vectors_match() {
    let f = fixture();
    assert_eq!(f["cases"].as_array().unwrap().len(), 234);
    for case in f["cases"].as_array().unwrap() {
        let text = case["text"].as_str().unwrap();
        assert_eq!(
            memory::tokenize(text),
            case["tokens"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_str().unwrap())
                .collect::<Vec<_>>()
        );
        let embedder = HashedEmbedder::new(case["dims"].as_u64().unwrap() as usize);
        let result = embedder.embed(text, EmbeddingKind::Document);
        assert_eq!(result.is_ok(), case["accepted"].as_bool().unwrap());
        if let Ok(vector) = result {
            let bits = vector.iter().map(|v| v.to_bits()).collect::<Vec<_>>();
            let mut expected = vec![0u64; case["dims"].as_u64().unwrap() as usize];
            for (index, value) in case["nonzeroBits"].as_object().unwrap() {
                expected[index.parse::<usize>().unwrap()] =
                    u64::from_str_radix(value.as_str().unwrap(), 16).unwrap();
            }
            assert_eq!(bits, expected, "dims={} text={text:?}", case["dims"]);
            let mut packed = vec![0u8; 4 * expected.len()];
            for (index, value) in case["nonzeroPacked"].as_object().unwrap() {
                let offset = 4 * index.parse::<usize>().unwrap();
                packed[offset..offset + 4].copy_from_slice(&bytes(value.as_str().unwrap()));
            }
            assert_eq!(memory::pack(&vector), packed);
            assert_eq!(
                memory::unpack(&memory::pack(&vector)).unwrap().len(),
                vector.len()
            );
        }
    }
}
#[test]
fn python_unicode_voice_normalization_is_frozen_independently_of_rust_unicode() {
    for case in fixture()["voice"].as_array().unwrap() {
        assert_eq!(
            memory::normalize_utterance(case["input"].as_str().unwrap()),
            case["output"].as_str().unwrap()
        );
    }
    assert_eq!(
        memory::episode_text("\x1c hi \x1f", " \u{85} bye "),
        "User: hi\nAssistant: bye"
    );
}
#[test]
fn reference_score_arithmetic_and_blob_refusals_match() {
    for case in fixture()["score"].as_array().unwrap() {
        let a = case["args"].as_array().unwrap();
        let weights = std::array::from_fn(|i| a[5][i].as_f64().unwrap());
        let score = memory::score_memory(
            a[0].as_f64().unwrap(),
            a[1].as_f64().unwrap(),
            a[2].as_f64().unwrap(),
            a[3].as_f64().unwrap(),
            a[4].as_f64().unwrap(),
            weights,
            a[6].as_str().unwrap(),
        )
        .unwrap();
        assert_eq!(
            format!("{:016x}", score.to_bits()),
            case["bits"].as_str().unwrap()
        );
    }
    assert!(memory::unpack(&[1, 2, 3]).is_err());
    assert!(memory::unpack(&[]).unwrap().is_empty());
    assert_eq!(memory::cosine(&[1.0], &[]), 0.0);
}
#[test]
fn python_http_float_coercion_and_metadata_repr_match() {
    let f = fixture();
    for case in f["floatText"].as_array().unwrap() {
        let points = case["points"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_u64().unwrap() as u32)
            .collect::<Vec<_>>();
        let result = memory::parse_embedding_float_text(&points);
        assert_eq!(
            result.is_ok(),
            case["accepted"].as_bool().unwrap(),
            "points={points:?}"
        );
        if let Ok(value) = result {
            assert_eq!(
                format!("{:016x}", value.to_bits()),
                case["bits"].as_str().unwrap(),
                "points={points:?}"
            );
        }
    }
    for case in f["repr"].as_array().unwrap() {
        let points = case["points"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_u64().unwrap() as u32)
            .collect::<Vec<_>>();
        assert_eq!(
            memory::quoted_memory_text(&points).unwrap(),
            case["expected"].as_str().unwrap()
        );
    }
    assert!(memory::quoted_memory_text(&[0x110000]).is_none());
}
#[test]
fn actual_real_power_edges_remain_valid_and_complex_results_are_explicit() {
    for case in fixture()["realEdges"].as_array().unwrap() {
        let args = case["bits"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| f64::from_bits(u64::from_str_radix(v.as_str().unwrap(), 16).unwrap()))
            .collect::<Vec<_>>();
        let actual = if case["kind"] == "recency" {
            memory::recency_score(args[0], args[1], args[2])
        } else {
            memory::score_memory(
                args[0],
                args[1],
                args[2],
                args[3],
                args[4],
                [args[5], args[6], args[7]],
                "product",
            )
        };
        if case["outcome"] == "real" {
            assert_eq!(
                format!("{:016x}", actual.unwrap().to_bits()),
                case["result"].as_str().unwrap(),
                "{}",
                case
            );
        } else {
            assert!(actual.is_err(), "{}", case);
        }
    }
}
