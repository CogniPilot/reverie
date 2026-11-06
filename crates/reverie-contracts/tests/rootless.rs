use reverie_contracts::{
    rootless::{RootlessConfig, RootlessImage, parse_host_grants},
    worker_config,
};
use reverie_core::rootless::{SubordinateId, SubordinateRange};
use serde::Deserialize;
#[derive(Deserialize)]
struct Corpus {
    uid: u32,
    gid: u32,
    name: String,
    profiles: Vec<Profile>,
    images: Vec<Image>,
    grants: Vec<Grant>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Profile {
    name: String,
    config: String,
    profile_hex: String,
    accepted: bool,
    enabled: Option<bool>,
    security: Vec<String>,
    runtime: Vec<String>,
}
#[derive(Deserialize)]
struct Image {
    raw: String,
    accepted: bool,
    converted: Option<String>,
}
#[derive(Deserialize)]
struct Grant {
    raw: String,
    accepted: bool,
    ranges: Vec<[String; 2]>,
}
fn corpus() -> Corpus {
    serde_json::from_str(include_str!("fixtures/rootless/legacy.json")).unwrap()
}
fn bytes(hex: &str) -> Vec<u8> {
    hex.as_bytes()
        .chunks_exact(2)
        .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
        .collect()
}
fn config(uid: u32, gid: u32) -> RootlessConfig {
    RootlessConfig::capture(worker_config::decode(format!(r#"{{"uid":{uid},"gid":{gid},"rootlessDocker":{{"enabled":true,"seccompProfile":"/nix/store/rootless-fixture","seccompSha256":"{}"}}}}"#,"0".repeat(64)).as_bytes()).unwrap()).unwrap()
}
#[test]
fn actual_profile_toggle_syscall_encoding_and_argument_vectors_match() {
    let corpus = corpus();
    assert!(corpus.profiles.len() > 40);
    for case in corpus.profiles {
        let captured = worker_config::decode(case.config.as_bytes()).unwrap();
        let before = worker_config::encode_config(&captured);
        let result = RootlessConfig::capture(captured).and_then(|config| {
            config.check_profile(&bytes(&case.profile_hex), None)?;
            Ok(config)
        });
        assert_eq!(result.is_ok(), case.accepted, "{}", case.name);
        if let Ok(config) = result {
            assert_eq!(Some(config.enabled()), case.enabled, "{}", case.name);
            assert_eq!(worker_config::encode_config(config.configuration()), before);
            assert_eq!(
                config
                    .security_args()
                    .iter()
                    .map(|text| text.scalar_text().unwrap())
                    .collect::<Vec<_>>(),
                case.security,
                "{}",
                case.name
            );
            assert_eq!(
                config
                    .runtime_args()
                    .iter()
                    .map(|text| text.scalar_text().unwrap())
                    .collect::<Vec<_>>(),
                case.runtime,
                "{}",
                case.name
            );
        }
    }
}
#[test]
fn image_labels_preserve_python_integer_conversions_and_unbounded_ranges() {
    let corpus = corpus();
    let config = config(corpus.uid, corpus.gid);
    let range = SubordinateRange::new(
        SubordinateId::parse("0").unwrap(),
        SubordinateId::parse(&format!("1{}", "0".repeat(400))).unwrap(),
    );
    for (index, case) in corpus.images.into_iter().enumerate() {
        let image = RootlessImage::decode(case.raw.as_bytes()).unwrap();
        let mappings = config.image_mappings(&image);
        if let Ok(Some(mappings)) = &mappings {
            assert_eq!(
                Some(mappings.uid_start().decimal()),
                case.converted,
                "image integer {index}"
            );
        }
        let accepted = mappings.is_ok_and(|value| {
            value
                .unwrap()
                .granted(std::slice::from_ref(&range), std::slice::from_ref(&range))
        });
        assert_eq!(accepted, case.accepted, "image {index}");
    }
}
#[test]
fn host_grant_text_matches_all_frozen_unicode_digit_and_splitline_cases() {
    let corpus = corpus();
    let name = corpus.name.chars().map(u32::from).collect::<Vec<_>>();
    assert!(corpus.grants.len() > 700);
    for (index, case) in corpus.grants.into_iter().enumerate() {
        let result = parse_host_grants(case.raw.as_bytes(), &name, corpus.uid);
        assert_eq!(result.is_ok(), case.accepted, "grant {index}");
        if let Ok(ranges) = result {
            assert_eq!(
                ranges
                    .iter()
                    .map(|range| [
                        range.low().as_str().to_owned(),
                        range.count().as_str().to_owned()
                    ])
                    .collect::<Vec<_>>(),
                case.ranges,
                "grant {index}"
            );
        }
    }
}
#[test]
fn disabled_options_need_no_identity_profile_image_or_account_validation() {
    let config=RootlessConfig::capture(worker_config::decode(br#"{"rootlessDocker":{"enabled":false,"seccompProfile":{"extra":NaN},"seccompSha256":-Infinity}}"#).unwrap()).unwrap();
    assert!(!config.enabled());
    config.check_profile(b"unread profile", None).unwrap();
    assert!(
        config
            .image_mappings(&RootlessImage::decode(b"null").unwrap())
            .unwrap()
            .is_none()
    );
    config
        .check_accounts(&[
            reverie_contracts::storage_identity::MetadataText::from_scalar_text("invalid//account"),
        ])
        .unwrap();
}
#[test]
fn profile_last_key_wins_is_isolated_from_fixed_perf_and_other_named_readers() {
    let raw = br#"{"defaultAction":"ALLOW","defaultAction":"SCMP_ACT_ERRNO","syscalls":[]}"#;
    assert!(reverie_contracts::task_perf_v1::TaskPerfProfile::decode(raw).is_err());
    assert!(worker_config::decode(raw).is_err());
    let case = corpus()
        .profiles
        .into_iter()
        .find(|case| case.name == "duplicate_final_good")
        .unwrap();
    let config =
        RootlessConfig::capture(worker_config::decode(case.config.as_bytes()).unwrap()).unwrap();
    config.check_profile(raw, None).unwrap();
}
#[test]
fn prepared_profile_data_cannot_be_reused_with_a_different_configured_digest() {
    let case = corpus()
        .profiles
        .into_iter()
        .find(|case| case.name == "base")
        .unwrap();
    let original =
        RootlessConfig::capture(worker_config::decode(case.config.as_bytes()).unwrap()).unwrap();
    let prepared = original
        .prepare_profile(&bytes(&case.profile_hex))
        .unwrap()
        .unwrap();
    original.check_prepared_profile(&prepared, None).unwrap();
    let different = config(1000, 1000);
    assert!(different.check_prepared_profile(&prepared, None).is_err());
}
