use super::{PythonText, PythonTextRef};
use serde_json::Value;
fn points(value: &Value) -> Vec<u32> {
    serde_json::from_value(value.clone()).unwrap()
}
#[test]
fn actual_python_owned_and_borrowed_text_preserve_codepoints_trim_and_slicing() {
    let corpus: Value = serde_json::from_str(include_str!("values-python.json")).unwrap();
    let cases = corpus.as_array().unwrap();
    assert_eq!(cases.len(), 12);
    for case in cases {
        let input = points(&case["points"]);
        let owned = PythonText::try_new(input.clone()).unwrap();
        let borrowed = PythonTextRef::from_codepoints(&input).unwrap();
        assert_eq!(owned.as_text_ref().codepoints().as_ref(), input);
        assert_eq!(borrowed.into_owned(), owned);
        assert_eq!(
            borrowed.scalar_text().is_some(),
            case["scalar"].as_bool().unwrap()
        );
        assert_eq!(
            borrowed.trimmed().codepoints().as_ref(),
            points(&case["trimmed"])
        );
        for take in case["takes"].as_array().unwrap() {
            assert_eq!(
                borrowed
                    .take(take["count"].as_u64().unwrap() as usize)
                    .codepoints()
                    .as_ref(),
                points(&take["points"])
            );
        }
        if let Some(scalar) = borrowed.scalar_text() {
            scalar_matches(&scalar, case);
        }
    }
}
fn scalar_matches(text: &str, case: &Value) {
    let borrowed = PythonTextRef::from_scalar_text(text);
    assert_eq!(borrowed, text);
    assert_eq!(borrowed.codepoints().as_ref(), points(&case["points"]));
    assert_eq!(
        borrowed.trimmed().codepoints().as_ref(),
        points(&case["trimmed"])
    );
    for take in case["takes"].as_array().unwrap() {
        assert_eq!(
            borrowed
                .take(take["count"].as_u64().unwrap() as usize)
                .codepoints()
                .as_ref(),
            points(&take["points"])
        );
    }
    assert_eq!(
        borrowed.take(usize::MAX).codepoints().as_ref(),
        points(&case["points"])
    );
}
#[test]
fn both_constructors_share_the_same_codepoint_invariant_without_normalizing_surrogates() {
    for invalid in [0x110000, u32::MAX] {
        assert!(PythonText::try_new(vec![invalid]).is_err());
        assert!(PythonTextRef::from_codepoints(&[invalid]).is_err());
    }
    let separate = PythonText::try_new(vec![0xd800, 0xdc00]).unwrap();
    assert_eq!(separate.codepoints(), &[0xd800, 0xdc00]);
    assert_eq!(separate.as_text_ref().scalar_text(), None);
    assert!(separate < PythonText::from_scalar_text("𐀀"));
    assert!(PythonText::from_scalar_text("PATH").equals_ascii("PATH"));
}
