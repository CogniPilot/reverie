//! Frozen worker_perf::_json boundaries through the public artifact reader.
use reverie_contracts::task_perf_v1::TaskPerfProfile;

#[test]
fn perf_artifacts_apply_python_default_integer_conversion() {
    let raw = |digits| {
        format!(
            r#"{{"defaultAction":"SCMP_ACT_ERRNO","syscalls":[],"opaque":{}}}"#,
            "7".repeat(digits)
        )
    };
    assert!(TaskPerfProfile::decode(raw(4300).as_bytes()).is_ok());
    assert_eq!(
        TaskPerfProfile::decode(raw(4301).as_bytes())
            .err()
            .map(|error| error.code()),
        Some("TASK_PERF_JSON")
    );
}

#[test]
fn perf_duplicate_hook_runs_when_each_object_closes() {
    for raw in [br#"{"x":0,"x":1,"tail":[}"#.as_slice(), br#"{"x":0,"x":[}"#] {
        assert_eq!(
            TaskPerfProfile::decode(raw).err().map(|error| error.code()),
            Some("TASK_PERF_JSON")
        );
    }
    assert_eq!(
        TaskPerfProfile::decode(br#"{"x":0,"x":1}"#)
            .err()
            .map(|error| error.code()),
        Some("DUPLICATE_KEY")
    );
}

#[test]
fn perf_keeps_nonfinite_values_and_python_byte_encodings() {
    let raw = r#"{"defaultAction":"SCMP_ACT_ERRNO","syscalls":[],"opaque":[NaN,Infinity,-Infinity,1e309]}"#;
    let utf16 = raw
        .encode_utf16()
        .flat_map(u16::to_le_bytes)
        .collect::<Vec<_>>();
    assert!(TaskPerfProfile::decode(raw.as_bytes()).is_ok());
    assert!(TaskPerfProfile::decode(&utf16).is_ok());
}
