use reverie_contracts::worker_config::{
    WorkerConfigError, config_digest, decode, encode_config, encode_policy, policy_digest,
};
use serde::Deserialize;

#[derive(Deserialize)]
struct Corpus {
    cases: Vec<Case>,
}
#[derive(Deserialize)]
struct Case {
    name: String,
    raw: String,
    config: String,
    policy: String,
    config_sha256: String,
    policy_sha256: String,
}

#[test]
fn actual_python_worker_bytes_and_hashes_match_all_synthetic_vectors() {
    let corpus: Corpus =
        serde_json::from_str(include_str!("fixtures/worker-config-python-interop.json")).unwrap();
    assert!(corpus.cases.len() >= 1500);
    for case in corpus.cases {
        let value =
            decode(case.raw.as_bytes()).unwrap_or_else(|error| panic!("{}: {error}", case.name));
        assert_eq!(
            encode_config(&value),
            case.config.as_bytes(),
            "{} config",
            case.name
        );
        assert_eq!(
            encode_policy(&value),
            case.policy.as_bytes(),
            "{} policy",
            case.name
        );
        assert_eq!(
            config_digest(&value).to_hex(),
            case.config_sha256,
            "{} config hash",
            case.name
        );
        assert_eq!(
            policy_digest(&value).to_hex(),
            case.policy_sha256,
            "{} policy hash",
            case.name
        );
        let again = decode(&encode_config(&value)).unwrap();
        assert_eq!(
            encode_config(&again),
            encode_config(&value),
            "{} round trip",
            case.name
        );
    }
}

#[test]
fn duplicate_keys_are_refused_at_every_depth_after_unescaping_and_pair_combining() {
    for raw in [
        r#"{"a": 1, "a": 2}"#,
        r#"{"a": 1, "\u0061": 2}"#,
        r#"{"nested":{"a":1,"a":2}}"#,
        r#"{"array":[{"a":1,"a":2}]}"#,
        "{\"😀\":1,\"\\ud83d\\ude00\":2}",
        r#"{"\ud800":1,"\ud800":2}"#,
    ] {
        assert!(
            matches!(decode(raw.as_bytes()), Err(WorkerConfigError::DuplicateKey)),
            "{raw}"
        );
    }
}

#[test]
fn legacy_nonfinite_data_spellings_and_overflow_survive_without_entering_resource_types() {
    let config = decode(br#"{"positive":1e309,"negative":-1e309,"array":[NaN,Infinity,-Infinity],"underflow":-1e-9999}"#).unwrap();
    assert_eq!(encode_config(&config), br#"{"array": [NaN, Infinity, -Infinity], "negative": -Infinity, "positive": Infinity, "underflow": -0.0}"#);
}

#[test]
fn malformed_json_never_produces_digest_input() {
    for raw in [
        "",
        "{",
        "{\"x\":}",
        "{\"x\":1,}",
        "{\"x\":[1,]}",
        "{\"x\":01}",
        "{\"x\":+1}",
        "{\"x\":.1}",
        "{\"x\":1.}",
        "{\"x\":1e}",
        "{\"x\":--1}",
        "{\"x\":NaNx}",
        "{\"x\":Infinityx}",
        "{\"x\":-Infinityx}",
        "{\"x\":+Infinity}",
        "{\"x\":nan}",
        "{\"x\":inf}",
        "{\"x\":-NaN}",
        "{\"x\":truefalse}",
        "{\"x\":null}false",
        r#"{"x":"\u123"}"#,
        r#"{"x":"\ud800\u12xz"}"#,
        r#"{"x":"\x00"}"#,
        "{\"x\":\"unescaped\ncontrol\"}",
        "\u{feff}{}",
    ] {
        assert!(
            matches!(decode(raw.as_bytes()), Err(WorkerConfigError::InvalidJson)),
            "{raw}"
        );
    }
    assert!(matches!(
        decode(b"{\"x\":\"\xff\"}"),
        Err(WorkerConfigError::InvalidJson)
    ));
    for raw in ["null", "[]", "0", "true", "\"text\""] {
        assert!(matches!(
            decode(raw.as_bytes()),
            Err(WorkerConfigError::ExpectedObject)
        ));
    }
}

#[test]
fn spacing_omission_and_top_level_policy_exclusions_are_exact() {
    let config = decode(br#"{"image":1,"maintenanceSessions":null,"opsConfig":{},"nested":{"image":1,"opsConfig":null},"imageSuffix":true}"#).unwrap();
    assert_eq!(
        encode_policy(&config),
        br#"{"imageSuffix": true, "nested": {"image": 1, "opsConfig": null}}"#
    );
    let omitted = decode(b"{}").unwrap();
    let null = decode(br#"{"leaseAcceptance":null}"#).unwrap();
    let empty = decode(br#"{"leaseAcceptance":{}}"#).unwrap();
    assert_ne!(config_digest(&omitted), config_digest(&null));
    assert_ne!(policy_digest(&null), policy_digest(&empty));
    let changed = decode(br#"{"image":2,"maintenanceSessions":[],"opsConfig":"different","nested":{"image":1,"opsConfig":null},"imageSuffix":true}"#).unwrap();
    assert_ne!(config_digest(&config), config_digest(&changed));
    assert_eq!(policy_digest(&config), policy_digest(&changed));
}

#[test]
fn data_encoding_adds_no_shallow_nesting_limit_and_error_cleanup_is_iterative() {
    let depth = 10_000;
    let raw = format!("{{\"x\":{}0{}}}", "[".repeat(depth), "]".repeat(depth));
    let value = decode(raw.as_bytes()).unwrap();
    let encoded = encode_config(&value);
    assert_eq!(encoded, raw.replace(":", ": ").as_bytes());
    drop(value);
    let invalid = format!(
        "{{\"x\":{}0{},\"bad\":}}",
        "[".repeat(depth),
        "]".repeat(depth)
    );
    assert!(decode(invalid.as_bytes()).is_err());
}

#[test]
fn launch_image_equivalence_preserves_full_python_equality_and_only_replaces_root_image() {
    use reverie_contracts::worker_config::image_only_equivalent;
    let pairs = [
        (
            r#"{"image":"a","cpus":0,"version":true}"#,
            r#"{"version":1.0,"cpus":0.0,"image":"b"}"#,
            true,
        ),
        (
            r#"{"image":"a","extra":{"x":NaN,"image":"nested"}}"#,
            r#"{"image":"b","extra":{"image":"nested","x":NaN}}"#,
            true,
        ),
        (
            r#"{"image":"a","extra":"\ud800\udc00"}"#,
            r#"{"image":"b","extra":"𐀀"}"#,
            true,
        ),
        (
            r#"{"image":"a","extra":"\ud800"}"#,
            r#"{"image":"b","extra":"\ud801"}"#,
            false,
        ),
        (
            r#"{"image":"a","extra":{"image":"old"}}"#,
            r#"{"image":"b","extra":{"image":"new"}}"#,
            false,
        ),
        (
            r#"{"image":"a","revision":1}"#,
            r#"{"image":"b","revision":2}"#,
            false,
        ),
        (
            r#"{"image":"a","owner":"one"}"#,
            r#"{"image":"b","owner":"two"}"#,
            false,
        ),
        (
            r#"{"image":"a","resourceReservations":null}"#,
            r#"{"image":"b"}"#,
            false,
        ),
        (
            r#"{"image":"a","memoryMiB":1024}"#,
            r#"{"image":"b","memoryMiB":2048}"#,
            false,
        ),
        (r#"{"image":"a"}"#, r#"{}"#, false),
    ];
    for (before, after, expected) in pairs {
        let before = decode(before.as_bytes()).unwrap();
        let after = decode(after.as_bytes()).unwrap();
        let original_before = encode_config(&before);
        let original_after = encode_config(&after);
        assert_eq!(
            image_only_equivalent(&before, &after),
            expected,
            "{:?} vs {:?}",
            original_before,
            original_after
        );
        assert_eq!(encode_config(&before), original_before);
        assert_eq!(encode_config(&after), original_after);
    }
}
