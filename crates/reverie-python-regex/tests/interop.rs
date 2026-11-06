use reverie_core::PythonText;
use reverie_python_regex::{CompiledOutputPolicy, CompiledPattern, RegexError};
use serde_json::Value;
fn text(value: &Value) -> PythonText {
    PythonText::try_new(
        value
            .as_array()
            .unwrap()
            .iter()
            .map(|point| u32::try_from(point.as_u64().unwrap()).unwrap())
            .collect(),
    )
    .unwrap()
}
fn check_error(error: RegexError, row: &Value) {
    assert_eq!(error.kind(), row["errorType"].as_str().unwrap(), "{row}");
    assert_eq!(
        error.codepoints(),
        text(&row["message"]).codepoints(),
        "{row}"
    );
}
fn check(raw: &str, expected_count: usize) {
    let mut count = 0;
    for line in raw.lines() {
        let row: Value = serde_json::from_str(line).unwrap();
        let pattern = text(&row["pattern"]);
        match CompiledPattern::compile(pattern.as_text_ref()) {
            Ok(pattern) => {
                assert_ne!(row["accepted"], false, "{row}");
                if row.get("text").is_none() {
                    count += 1;
                    continue;
                }
                let input = text(&row["text"]);
                assert_eq!(
                    pattern.is_match(input.as_text_ref()),
                    row["expected"].as_bool().unwrap(),
                    "{row}"
                );
            }
            Err(error) => {
                assert_eq!(row["accepted"], false, "{row}: {error}");
                check_error(error, &row);
            }
        }
        count += 1;
    }
    assert_eq!(count, expected_count);
}
#[test]
fn cpython_original_and_generated_matchers() {
    check(
        include_str!("fixtures/cpython313-all-matchers-r1.jsonl"),
        425,
    );
    check(
        include_str!("fixtures/cpython313-generated-deeper-r2.jsonl"),
        8130,
    );
}
#[test]
fn capture_savepoints_and_scoped_charset_prefix_semantics() {
    check(
        include_str!("fixtures/cpython313-mark-frames-r1.jsonl"),
        1800,
    );
    check(
        include_str!("fixtures/cpython313-prefix-info-r1.jsonl"),
        9900,
    );
}
#[test]
fn full_grammar_diagnostic_order_and_lossless_error_text() {
    check(
        include_str!("fixtures/cpython313-grammar-matrix-r1.jsonl"),
        629,
    );
    check(include_str!("fixtures/native-error-input-r1.jsonl"), 55);
    check(
        include_str!("fixtures/cpython313-lexical-fuzz-r1.jsonl"),
        12000,
    );
}
#[test]
fn every_pattern_compiles_before_any_search() {
    for line in include_str!("fixtures/native-policy-phase-input-r1.jsonl").lines() {
        let row: Value = serde_json::from_str(line).unwrap();
        let patterns = row["patterns"]
            .as_array()
            .unwrap()
            .iter()
            .map(text)
            .collect::<Vec<_>>();
        let actual = CompiledOutputPolicy::compile(patterns.iter().map(PythonText::as_text_ref));
        match actual {
            Err(error) => check_error(error, &row),
            Ok(policy) => assert_eq!(
                policy.is_match(text(&row["text"]).as_text_ref()),
                row["result"].as_bool().unwrap(),
                "{row}"
            ),
        }
    }
}
#[test]
fn valid_deep_grammar_is_iterative_beyond_python_interpreter_recursion_limit() {
    for line in include_str!("fixtures/cpython313-deep-patterns-r1.jsonl").lines() {
        let row: Value = serde_json::from_str(line).unwrap();
        let pattern = CompiledPattern::compile(text(&row["pattern"]).as_text_ref()).unwrap();
        assert!(!pattern.is_match(PythonText::from_scalar_text("b").as_text_ref()));
    }
}
#[test]
fn canonical_name_hash_collisions_never_accept_an_extra_suffix() {
    let rows: Value =
        serde_json::from_str(include_str!("fixtures/cpython313-name-suffix-r1.json")).unwrap();
    for row in rows["rows"].as_array().unwrap() {
        let name = row["name"].as_str().unwrap();
        assert_eq!(
            reverie_core::python_regex::named_character(name),
            None,
            "{name}"
        );
        let error = match CompiledPattern::compile(text(&row["pattern"]).as_text_ref()) {
            Ok(_) => panic!("invalid name accepted: {name}"),
            Err(error) => error,
        };
        assert_eq!(
            error.codepoints(),
            text(&row["error"]).codepoints(),
            "{name}"
        );
    }
    assert_eq!(rows["rows"].as_array().unwrap().len(), 16);
}
#[test]
fn nested_lazy_optional_zero_width_state_and_independent_advanced_cases() {
    check(
        include_str!("fixtures/cpython313-independent-advanced-r1.jsonl"),
        6499,
    );
    check(
        include_str!("fixtures/cpython313-zero-width-repeat-r1.jsonl"),
        1620,
    );
}
