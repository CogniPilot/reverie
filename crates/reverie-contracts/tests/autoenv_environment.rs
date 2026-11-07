use reverie_contracts::autoenv_environment::{AutoenvEnvironment, EnvironmentError};
#[test]
fn exported_only_last_wins_nul_omission_and_denied_identity_are_preserved() {
    let raw = br#"{"variables":{"HOME":{"type":"exported","value":"/other"},"z":{"type":"exported","value":"first"},"z":{"type":"exported","value":"last"},"a":{"type":"exported","value":"line\n=value"},"local":{"type":"local","value":"ignored"},"NUL":{"type":"exported","value":"a\u0000b"},"number":{"type":"exported","value":Infinity},"ignored":{"type":"local","value":"\ud800"}}}"#;
    let environment = AutoenvEnvironment::from_nix_text(raw).unwrap();
    assert_eq!(environment.cache_bytes(), b"a=line\n=value\0z=last\0");
    assert_eq!(
        AutoenvEnvironment::from_cache(&environment.cache_bytes())
            .unwrap()
            .cache_bytes(),
        environment.cache_bytes()
    );
    assert!(
        AutoenvEnvironment::from_cache(b"")
            .unwrap()
            .assignments()
            .next()
            .is_none()
    );
}
#[test]
fn malformed_shapes_invalid_encoding_and_eligible_bad_names_refuse() {
    for raw in [
        b"null".as_slice(),
        br#"{"variables":[]}"#,
        br#"{"variables":{"HOME":null}}"#,
        br#"{"variables":{"x":[]}}"#,
    ] {
        assert_eq!(
            AutoenvEnvironment::from_nix_text(raw).unwrap_err(),
            EnvironmentError::Variables
        );
    }
    for name in [r"prefix\u0000HOME", "a=b", "", "1key", "a-b", "é"] {
        let raw = format!(r#"{{"variables":{{"{name}":{{"type":"exported","value":"value"}}}}}}"#);
        assert_eq!(
            AutoenvEnvironment::from_nix_text(raw.as_bytes()).unwrap_err(),
            EnvironmentError::Assignment
        );
    }
    assert_eq!(
        AutoenvEnvironment::from_nix_text(
            br#"{"variables":{"x":{"type":"exported","value":"\ud800"}}}"#
        )
        .unwrap_err(),
        EnvironmentError::Encoding
    );
    assert_eq!(
        AutoenvEnvironment::from_nix_text(b"\xef\xbb\xbf{}").unwrap_err(),
        EnvironmentError::Json
    );
    for raw in [
        b"a=x".as_slice(),
        b"a=x\0a=y\0",
        b"a=x\0HOME=y\0",
        b"a=x\0\0",
        b"a=\xff\0",
    ] {
        assert_eq!(
            AutoenvEnvironment::from_cache(raw).unwrap_err(),
            EnvironmentError::Cache
        );
    }
}
