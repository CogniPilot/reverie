use reverie_contracts::{broker_resources as config, profiles_v1};
use reverie_core::ids::{ProfileEmployeeId, ProfileSessionId};
use reverie_core::profiles::ProfileDocument;
use reverie_core::resource_projection::ProfileStageRequest;
use reverie_core::revision::{ObservedProfileVersion, StoreRevision};
use serde::Deserialize;
use std::collections::BTreeMap;

#[derive(Deserialize)]
struct Corpus {
    cases: Vec<Case>,
}
#[derive(Deserialize)]
struct Case {
    name: String,
    input: String,
    document: String,
    employee: String,
    revision: u64,
    version: u64,
    owners: BTreeMap<String, String>,
    output: String,
    target: String,
    profile_sha256: String,
}
fn corpus() -> Corpus {
    serde_json::from_str(include_str!("fixtures/broker-resource-staging.json")).unwrap()
}
fn request(
    case: &Case,
    document: &ProfileDocument,
    revision: u64,
    version: u64,
) -> ProfileStageRequest {
    let employee = ProfileEmployeeId::parse(&case.employee).unwrap();
    let binding = document.profiles()[&employee].binding().clone();
    let owners = case
        .owners
        .iter()
        .map(|(sid, owner)| {
            (
                ProfileSessionId::parse(sid).unwrap(),
                ProfileEmployeeId::parse(owner).unwrap(),
            )
        })
        .collect();
    ProfileStageRequest::try_new(
        employee,
        binding,
        StoreRevision::try_new(revision).unwrap(),
        ObservedProfileVersion::try_new(version).unwrap(),
        &owners,
    )
    .unwrap()
}

#[test]
fn existing_stage_config_canonical_output_matches_all_synthetic_reference_cases() {
    let cases = corpus().cases;
    assert_eq!(cases.len(), 6);
    for case in cases {
        let document = profiles_v1::decode(case.document.as_bytes()).unwrap();
        let original = profiles_v1::encode(&document).unwrap();
        let stage = request(&case, &document, case.revision, case.version);
        let input = config::decode(case.input.as_bytes()).unwrap();
        let result = input.stage(&document, &stage).unwrap();
        assert_eq!(
            result.configuration_bytes(),
            case.output.as_bytes(),
            "{}",
            case.name
        );
        assert_eq!(result.resources().target_session().as_str(), case.target);
        assert_eq!(result.resources().store_revision().get(), case.revision);
        assert_eq!(result.resources().profile_version().get(), case.version);
        assert_eq!(
            profiles_v1::profile_digest(result.resources().profile())
                .unwrap()
                .to_hex(),
            case.profile_sha256,
            "{} original profile digest",
            case.name
        );
        assert_eq!(profiles_v1::encode(&document).unwrap(), original);
    }
}

#[test]
fn staging_clone_bound_is_compact_ascii_input_not_raw_whitespace_or_output_size() {
    let limit = profiles_v1::MAX_BYTES;
    let overhead = br#"{"padding":""}"#.len();
    let raw = format!("{{\"padding\":\"{}\"}}", "x".repeat(limit - overhead));
    assert_eq!(raw.len(), limit);
    assert!(config::decode(raw.as_bytes()).is_ok());
    assert!(config::decode(format!(" \n{raw}\t").as_bytes()).is_ok());
    let extra = raw.replacen('x', "xx", 1);
    assert!(matches!(
        config::decode(extra.as_bytes()),
        Err(config::ResourceConfigError::StoreBound)
    ));
    let escaped = format!("{{\"padding\":\"{}\"}}", "é".repeat(limit / 4));
    assert!(escaped.len() < limit);
    assert!(matches!(
        config::decode(escaped.as_bytes()),
        Err(config::ResourceConfigError::StoreBound)
    ));
    let case = corpus().cases.remove(0);
    let document = profiles_v1::decode(case.document.as_bytes()).unwrap();
    let stage = request(&case, &document, case.revision, case.version);
    let result = config::decode(raw.as_bytes())
        .unwrap()
        .stage(&document, &stage)
        .unwrap();
    assert!(result.configuration_bytes().len() > limit);
}

#[test]
fn profile_staging_refuses_nonfinite_even_when_general_worker_hash_data_accepts_it() {
    for value in ["NaN", "Infinity", "-Infinity", "1e309"] {
        let raw =
            format!("{{\"rootlessDocker\":{{\"enabled\":false,\"seccompProfile\":{value}}}}}");
        assert!(reverie_contracts::worker_config::decode(raw.as_bytes()).is_ok());
        assert!(matches!(
            config::decode(raw.as_bytes()),
            Err(config::ResourceConfigError::NonfiniteData)
        ));
    }
}

#[test]
fn closed_resource_fields_and_integer_kinds_remain_checked_before_projection() {
    let policy = r#"{"budgetMode":"admission","memoryMiB":4096,"pidsLimit":512,"cpus":1.0,"poolMemoryMiB":8192,"poolTasksMax":1024}"#;
    let sid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    for invalid in [
        policy.replace("4096", "true"),
        policy.replace("4096", "4096.0"),
        policy.replace("1.0", "true"),
        policy.replace("1024}", "1024,\"extra\":0}"),
        policy.replace("\"admission\"", "\"unknown\""),
    ] {
        let raw = format!("{{\"sessionResources\":{{\"{sid}\":{invalid}}}}}");
        assert!(config::decode(raw.as_bytes()).is_err(), "{invalid}");
    }
    for raw in [
        "{\"employeeResources\":null}",
        "{\"sessionResources\":[]}",
        "{\"resourceReservations\":null}",
        "{\"x\":0,\"x\":1}",
        "[]",
    ] {
        assert!(config::decode(raw.as_bytes()).is_err(), "{raw}");
    }
}

#[test]
fn stage_propagates_canonical_revision_and_profile_version_refusals() {
    let case = corpus().cases.remove(0);
    let document = profiles_v1::decode(case.document.as_bytes()).unwrap();
    for (revision, version, code) in [
        (0, 1, "STALE_STORE_REVISION"),
        (1, 2, "STALE_PROFILE_OR_BINDING"),
    ] {
        let stage = request(&case, &document, revision, version);
        let result = config::decode(case.input.as_bytes())
            .unwrap()
            .stage(&document, &stage);
        let Err(error) = result else {
            panic!("stale input accepted")
        };
        assert_eq!(error.code(), code);
    }
}
