use reverie_contracts::broker_laptop::{LaptopReadError, LaunchRuntimeData};
#[test]
fn runtime_text_codec_preserves_last_wins_unknown_json_and_python_codepoint_paths() {
    for (raw, wanted) in [
        (
            br#"{"exit":"first","exit":"last","unknown":NaN}"#.as_slice(),
            "last".chars().map(u32::from).collect::<Vec<_>>(),
        ),
        (br#"{"exit":""}"#.as_slice(), vec![]),
        (
            br#"{"exit":"/absolute/../receipt"}"#.as_slice(),
            "/absolute/../receipt".chars().map(u32::from).collect(),
        ),
        (br#"{"exit":"\udcff\u0000"}"#.as_slice(), vec![0xdcff, 0]),
    ] {
        assert_eq!(
            LaunchRuntimeData::decode_read_text(raw)
                .unwrap()
                .exit()
                .codepoints(),
            wanted
        );
    }
}
#[test]
fn runtime_read_text_never_uses_bytes_json_bom_autodetection_or_invents_missing_fields() {
    for raw in [
        b"[]".as_slice(),
        b"{}",
        br#"{"exit":17}"#,
        br#"{"exit":null}"#,
    ] {
        assert!(matches!(
            LaunchRuntimeData::decode_read_text(raw),
            Err(LaptopReadError::Structure)
        ));
    }
    for raw in [
        b"\xef\xbb\xbf{\"exit\":\"x\"}".as_slice(),
        b"\xff\xfe{\0}",
        br#"{"exit":"x"} trailing"#,
    ] {
        assert!(matches!(
            LaunchRuntimeData::decode_read_text(raw),
            Err(LaptopReadError::Json)
        ));
    }
}
