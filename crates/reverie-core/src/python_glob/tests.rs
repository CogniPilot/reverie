use super::*;
use crate::PythonText;

fn points(value: &serde_json::Value) -> PythonText {
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
#[test]
fn actual_python_fnmatchcase_corpus_preserves_classes_paths_and_lossless_codepoints() {
    let corpus: serde_json::Value =
        serde_json::from_str(include_str!("fnmatch-python.json")).unwrap();
    let values: Vec<_> = corpus["values"]
        .as_array()
        .unwrap()
        .iter()
        .map(points)
        .collect();
    let patterns = corpus["patterns"].as_array().unwrap();
    assert!(patterns.len() > 900);
    for row in patterns {
        let pattern = points(&row["pattern"]);
        let compiled = PythonGlob::compile(PythonTextRef::from_owned(&pattern));
        let expected = row["matches"].as_array().unwrap();
        assert_eq!(expected.len(), values.len());
        for (value, expected) in values.iter().zip(expected) {
            assert_eq!(
                compiled.is_match(PythonTextRef::from_owned(value)),
                expected.as_bool().unwrap(),
                "pattern {:?}, value {:?}",
                pattern.codepoints(),
                value.codepoints()
            );
        }
    }
}
#[test]
fn long_star_patterns_use_no_recursive_parser_or_matcher_stack() {
    let pattern = format!("{}a", "*".repeat(100_000));
    let compiled = PythonGlob::compile(PythonTextRef::from_scalar_text(&pattern));
    assert!(compiled.is_match(PythonTextRef::from_scalar_text("/owned/a")));
    assert!(!compiled.is_match(PythonTextRef::from_scalar_text("/owned/b")));
}
