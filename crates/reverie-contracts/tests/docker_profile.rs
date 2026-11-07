use reverie_contracts::docker_profile::{
    DockerProfileError, MAX_PROFILE_BYTES, produce_docker_profile,
};
use serde_json::Value;

#[test]
fn actual_original_producer_vectors_preserve_default_deny_and_exact_json_bytes() {
    let cases: Value =
        serde_json::from_str(include_str!("fixtures/docker-profile-oracle.json")).unwrap();
    for case in cases.as_array().unwrap() {
        let source = case["source"].as_str().unwrap();
        let result = produce_docker_profile(source.as_bytes());
        if let Some(expected) = case["expected"].as_str() {
            assert_eq!(result.unwrap(), expected.as_bytes(), "{source}");
        } else {
            assert!(result.is_err(), "{source}");
        }
    }
}

#[test]
fn fixed_build_bounds_refuse_input_or_output_before_output_publication() {
    assert_eq!(
        produce_docker_profile(&vec![b' '; MAX_PROFILE_BYTES + 1]),
        Err(DockerProfileError::Bound)
    );
    let source = format!(
        "{{\"defaultAction\":\"SCMP_ACT_ERRNO\",\"syscalls\":[],\"extra\":\"{}\"}}",
        "x".repeat(MAX_PROFILE_BYTES - 100)
    );
    assert!(source.len() < MAX_PROFILE_BYTES);
    assert_eq!(
        produce_docker_profile(source.as_bytes()),
        Err(DockerProfileError::Bound)
    );
}
