use reverie_core::{
    PythonText,
    memory_configuration::{
        AgentSettings, ConfigInteger, FloatSetting, IntegerSetting, TextSetting,
    },
};
use std::collections::BTreeMap;
#[test]
fn negative_and_overflow_configured_dimensions_keep_actual_python_success_boundaries() {
    use reverie_core::memory::{Embedder, EmbeddingKind, HashedEmbedder};
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/memory-configuration-python.json")).unwrap();
    for case in fixture["hashedConfiguredDimensions"].as_array().unwrap() {
        let dimensions = ConfigInteger::parse(&PythonText::from_scalar_text(
            case["dimensions"].as_str().unwrap(),
        ))
        .unwrap();
        let embedder = HashedEmbedder::from_configured_dimensions(&dimensions);
        assert_eq!(embedder.name(), case["name"].as_str().unwrap());
        let result = embedder.embed(case["text"].as_str().unwrap(), EmbeddingKind::Query);
        if let Some(bits) = case["bits"].as_array() {
            assert_eq!(
                result
                    .unwrap()
                    .into_iter()
                    .map(|value| format!("{:016x}", value.to_bits()))
                    .collect::<Vec<_>>(),
                bits.iter()
                    .map(|value| value.as_str().unwrap())
                    .collect::<Vec<_>>()
            );
        } else {
            assert!(result.is_err());
        }
    }
}
#[test]
fn actual_python_environment_numeric_coercion_preserves_defaults_and_large_integers() {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/memory-configuration-python.json")).unwrap();
    for case in fixture["cases"].as_array().unwrap() {
        let points = case["text"]
            .as_array()
            .unwrap()
            .iter()
            .map(|point| point.as_u64().unwrap() as u32)
            .collect();
        let value = PythonText::try_new(points).unwrap();
        let integer = ConfigInteger::parse(&value).unwrap_or_else(|| ConfigInteger::from_i64(37));
        assert_eq!(integer.as_str(), case["integer"].as_str().unwrap());
        let float =
            reverie_core::memory::parse_embedding_float_text(value.codepoints()).unwrap_or(37.0);
        assert_eq!(
            format!("{:016x}", float.to_bits()),
            case["floatBits"].as_str().unwrap()
        );
    }
}
#[test]
fn complete_settings_snapshot_retains_independent_model_dimensions_prefixes_and_nonfinite_values() {
    let environment = BTreeMap::from([
        (
            "REVERIE_EMBED_DIMS".into(),
            PythonText::from_scalar_text("-1"),
        ),
        (
            "REVERIE_EMBED_MODEL".into(),
            PythonText::try_new(vec![0xd800]).unwrap(),
        ),
        (
            "REVERIE_EMBED_DOC_PREFIX".into(),
            PythonText::from_scalar_text("custom-document: "),
        ),
        (
            "REVERIE_EMBED_QUERY_PREFIX".into(),
            PythonText::from_scalar_text("custom-query: "),
        ),
        (
            "REVERIE_RECENCY_DECAY".into(),
            PythonText::from_scalar_text("NaN"),
        ),
        (
            "REVERIE_TIMEOUT".into(),
            PythonText::from_scalar_text("99999999999999999999999999999999"),
        ),
        ("REVERIE_MODEL".into(), PythonText::from_scalar_text("")),
    ]);
    let settings = AgentSettings::capture(&environment);
    for &(key, _, _) in IntegerSetting::definitions() {
        let _ = settings.integer(key);
    }
    for &(key, _, _) in FloatSetting::definitions() {
        let _ = settings.float(key);
    }
    for &(key, _, _) in TextSetting::definitions() {
        let _ = settings.text(key);
    }
    assert_eq!(
        settings.integer(IntegerSetting::EmbedDimensions).as_str(),
        "-1"
    );
    assert_eq!(
        settings.integer(IntegerSetting::RequestTimeout).as_str(),
        "99999999999999999999999999999999"
    );
    assert_eq!(
        settings.text(TextSetting::EmbedModel).codepoints(),
        [0xd800]
    );
    assert_eq!(
        settings
            .text(TextSetting::EmbedDocumentPrefix)
            .as_text_ref()
            .scalar_text()
            .as_deref(),
        Some("custom-document: ")
    );
    assert_eq!(
        settings
            .text(TextSetting::EmbedQueryPrefix)
            .as_text_ref()
            .scalar_text()
            .as_deref(),
        Some("custom-query: ")
    );
    assert_eq!(
        settings
            .text(TextSetting::Model)
            .as_text_ref()
            .scalar_text()
            .as_deref(),
        Some("MODEL_ID")
    );
    assert!(settings.float(FloatSetting::RecencyDecay).is_nan());
}
