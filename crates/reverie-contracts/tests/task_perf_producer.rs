use reverie_contracts::task_perf_v1::{PerfSystem, produce_task_perf};
use serde_json::Value;

#[test]
fn actual_legacy_producer_bytes_include_default_spaces_ascii_hashes_and_newlines() {
    let corpus: Value =
        serde_json::from_str(include_str!("fixtures/task_perf/producer-vectors.json")).unwrap();
    for case in corpus["cases"].as_array().unwrap() {
        let produced = produce_task_perf(
            case["basePath"].as_str().unwrap(),
            case["selectedPath"].as_str().unwrap(),
            PerfSystem::from_name(case["system"].as_str().unwrap()).unwrap(),
            case["base"].as_str().unwrap().as_bytes(),
        )
        .unwrap();
        assert_eq!(
            produced.profile(),
            case["profile"].as_str().unwrap().as_bytes(),
            "{} profile",
            case["name"]
        );
        assert_eq!(
            produced.manifest(),
            case["manifest"].as_str().unwrap().as_bytes(),
            "{} manifest",
            case["name"]
        );
    }
}
#[test]
fn producer_refuses_unsupported_system_invalid_or_already_derived_base() {
    assert!(PerfSystem::from_name("x86_64-darwin").is_err());
    for base in [
        br#"[]"#.as_slice(),
        br#"{"defaultAction":"SCMP_ACT_ALLOW","syscalls":[]}"#,
        br#"{"defaultAction":"SCMP_ACT_ERRNO","syscalls":[],"syscalls":[]}"#,
    ] {
        assert!(produce_task_perf("base", "selected", PerfSystem::X86_64Linux, base).is_err());
    }
    let produced = produce_task_perf(
        "base",
        "selected",
        PerfSystem::X86_64Linux,
        br#"{"defaultAction":"SCMP_ACT_ERRNO","syscalls":[]}"#,
    )
    .unwrap();
    assert!(
        produce_task_perf(
            "base",
            "selected",
            PerfSystem::X86_64Linux,
            produced.profile()
        )
        .is_err()
    );
    assert!(
        produce_task_perf(
            "base",
            "selected",
            PerfSystem::X86_64Linux,
            &vec![b' '; 65537]
        )
        .is_err()
    );
    let near_bound = format!(
        "{{\"defaultAction\":\"SCMP_ACT_ERRNO\",\"syscalls\":[],\"extra\":\"{}\"}}",
        "x".repeat(65_400)
    );
    assert!(near_bound.len() < 65_536);
    assert!(
        produce_task_perf(
            "base",
            "selected",
            PerfSystem::X86_64Linux,
            near_bound.as_bytes()
        )
        .is_err()
    );
    assert!(
        produce_task_perf(
            "base",
            &"x".repeat(65_536),
            PerfSystem::X86_64Linux,
            br#"{"defaultAction":"SCMP_ACT_ERRNO","syscalls":[]}"#
        )
        .is_err()
    );
}
