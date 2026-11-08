use super::*;

fn image(digit: char) -> WorkerImageId {
    WorkerImageId::parse(&format!("sha256:{}", digit.to_string().repeat(64))).unwrap()
}

#[test]
fn image_edit_preserves_every_nonimage_byte_including_escaped_key_and_nested_pin() {
    let old = image('a');
    let new = image('b');
    let source=concat!(r#"{ "nested" : {"image": "$OLD"}, "im\u0061ge" : "$OLD", "text": "caf\u00e9\ud800", "number": 1.00e+00 }"#,"\r\n").replace("$OLD",old.as_str());
    let edit = ImageConfigurationEdit::prepare(source.as_bytes(), &old, new.clone()).unwrap();
    let expected = source.replace(
        &format!(r#""im\u0061ge" : "{}""#, old.as_str()),
        &format!(r#""im\u0061ge" : "{}""#, new.as_str()),
    );
    assert_eq!(edit.candidate_bytes(), expected.as_bytes());
    assert_eq!(edit.before_bytes(), source.as_bytes());
    assert_eq!(edit.old_image(), &old);
    assert_eq!(edit.new_image(), &new);
    assert_ne!(edit.before_digest(), edit.after_digest());
}

#[test]
fn image_edit_refuses_foreign_old_pin_ambiguous_keys_and_nonimage_sources() {
    let old = image('a');
    let new = image('b');
    for raw in [
        format!(
            r#"{{"image":"{}","im\u0061ge":"{}"}}"#,
            old.as_str(),
            old.as_str()
        ),
        format!(r#"{{"image":"{}","nested":{{"x":1,"x":2}}}}"#, old.as_str()),
        format!(r#"{{"image":"{}"}} trailing"#, old.as_str()),
        format!(r#"[{{"image":"{}"}}]"#, old.as_str()),
        r#"{"image":true}"#.to_owned(),
        r#"{"other":"image"}"#.to_owned(),
    ] {
        assert!(ImageConfigurationEdit::prepare(raw.as_bytes(), &old, new.clone()).is_err());
    }
    let raw = format!(r#"{{"image":"{}"}}"#, old.as_str());
    assert!(ImageConfigurationEdit::prepare(raw.as_bytes(), &new, old.clone()).is_err());
    assert!(ImageConfigurationEdit::prepare(raw.as_bytes(), &old, old.clone()).is_err());
}

#[test]
fn exact_image_ids_reject_tags_short_ids_and_noncanonical_digests() {
    for raw in [
        "latest",
        "reverie:latest",
        "sha256:a",
        &format!("sha256:{}", "A".repeat(64)),
        &format!("sha256:{}", "g".repeat(64)),
    ] {
        assert!(WorkerImageId::parse(raw).is_err());
    }
    assert_eq!(image('a').as_str(), format!("sha256:{}", "a".repeat(64)));
}
