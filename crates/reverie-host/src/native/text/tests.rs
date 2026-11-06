use super::*;
#[test]
fn actual_python_filesystem_byte_decode_and_encode_preserve_every_byte() {
    let corpus: serde_json::Value = serde_json::from_str(include_str!(
        "../../../tests/fixtures/native-path-text-python.json"
    ))
    .unwrap();
    let cases = corpus["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 136);
    for case in cases {
        let raw: Vec<u8> = case["raw"]
            .as_array()
            .unwrap()
            .iter()
            .map(|n| u8::try_from(n.as_u64().unwrap()).unwrap())
            .collect();
        let points: Vec<u32> = case["points"]
            .as_array()
            .unwrap()
            .iter()
            .map(|n| u32::try_from(n.as_u64().unwrap()).unwrap())
            .collect();
        let path = PathBuf::from(OsString::from_vec(raw.clone()));
        assert_eq!(python_text(&path), points, "{raw:?}");
        assert_eq!(python_path(&points).unwrap().as_os_str().as_bytes(), raw);
    }
}
#[test]
fn native_path_encoding_rejects_non_surrogateescape_codepoints_without_replacement() {
    for point in [0xd800, 0xdbff, 0xdc00, 0xdc7f, 0x110000] {
        assert_eq!(
            python_path(&[point]).unwrap_err().kind(),
            std::io::ErrorKind::InvalidInput
        );
    }
    assert_eq!(python_path(&[0]).unwrap().as_os_str().as_bytes(), &[0]);
}
