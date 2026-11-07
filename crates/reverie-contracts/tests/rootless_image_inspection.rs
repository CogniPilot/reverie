use reverie_contracts::{rootless::RootlessImage, storage_identity::MetadataText};

#[test]
fn image_inspection_uses_stdout_text_rules_and_refuses_utf8_bom() {
    let expected = MetadataText::from_scalar_text("sha256:selected");
    let plain = br#"[{"Id":"sha256:selected"}]"#;
    let mut cases = vec![[b"\xef\xbb\xbf".as_slice(), plain].concat()];
    for width in [2, 4] {
        for little in [false, true] {
            let mut raw = Vec::new();
            let index = if little { 0 } else { width - 1 };
            for &byte in plain {
                let mut word = vec![0; width];
                word[index] = byte;
                raw.extend(word);
            }
            cases.push(raw);
        }
    }
    for raw in cases {
        assert!(std::str::from_utf8(&raw).is_ok(), "valid captured stdout");
        assert!(RootlessImage::decode_inspection(&raw, &expected).is_err());
    }
}

#[test]
fn image_inspection_requires_one_object_and_exact_selected_identity() {
    let expected = MetadataText::from_scalar_text("sha256:selected");
    for raw in [
        br#"[{"Id":"sha256:selected"}]"#.as_slice(),
        br#"[{"Id":"old","Id":"sha256:selected","future":{"keep":true}}]"#,
    ] {
        assert!(RootlessImage::decode_inspection(raw, &expected).is_ok());
    }
    for raw in [
        br#"[]"#.as_slice(),
        br#"null"#,
        br#"{}"#,
        br#"[null]"#,
        br#"[{},{}]"#,
        br#"[{"Id":"sha256:selected"},{}]"#,
        br#"[{"Id":"different"}]"#,
        br#"[{"Id":null}]"#,
        br#"[{"Id":true}]"#,
        br#"[{"Id":"sha256:selected","Id":"different"}]"#,
        br#"[{"Id":"sha256:selected"},]"#,
    ] {
        assert!(
            RootlessImage::decode_inspection(raw, &expected).is_err(),
            "{raw:?}"
        );
    }
}
