use reverie_contracts::task_perf_v1::{
    PerfSystem, TaskPerfArtifactData, TaskPerfConfiguration, TaskPerfError, TaskPerfManifest,
    TaskPerfProfile,
};
use reverie_contracts::worker_config::encode_config;
use reverie_core::ids::ProfileEmployeeId;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

const EMPLOYEE: &str = "11111111-1111-4111-8111-111111111111";
const OTHER: &str = "22222222-2222-4222-8222-222222222222";
const BASE: &str = "/nix/store/fixed-base-profile";
const SELECTED: &str = "/nix/store/fixed-task-profile";
fn hash(raw: &[u8]) -> String {
    format!("{:x}", Sha256::digest(raw))
}
fn base() -> Vec<u8> {
    br#"{"defaultAction":"SCMP_ACT_ERRNO","syscalls":[{"names":["read"],"action":"SCMP_ACT_ALLOW"}],"unknown":{"unchanged":true}}"#.to_vec()
}
fn manifest(base: &[u8], selected: &[u8]) -> Value {
    json!({"version":1,"purpose":"worker-task-perf-profile-v1","system":"x86_64-linux",
        "baseProfile":BASE,"baseSHA256":hash(base),"profile":SELECTED,"profileSHA256":hash(selected)})
}
fn artifact() -> TaskPerfArtifactData {
    let base = base();
    let selected = TaskPerfProfile::decode(&base)
        .unwrap()
        .derivative()
        .unwrap()
        .encode();
    let manifest = TaskPerfManifest::decode(
        &serde_json::to_vec(&manifest(&base, &selected)).unwrap(),
        PerfSystem::X86_64Linux,
    )
    .unwrap();
    TaskPerfArtifactData::verify(manifest, &base, &selected).unwrap()
}
fn config(artifact: &TaskPerfArtifactData) -> Value {
    json!({"employeePerfPolicies":{EMPLOYEE:"task-v1"},"rootlessDocker":{"enabled":true,
        "seccompProfile":BASE,"seccompSha256":artifact.manifest().base_sha256(),"unrelated":[1,true,"é"]},
        "grants":{"GPU":false},"desiredRunning":false,"onVacation":true})
}
fn decode(value: &Value) -> TaskPerfConfiguration {
    TaskPerfConfiguration::decode(&serde_json::to_vec(value).unwrap()).unwrap()
}

#[test]
fn actual_python_derivative_and_numeric_equality_vectors_match() {
    let corpus: Value =
        serde_json::from_str(include_str!("fixtures/task_perf/legacy-vectors.json")).unwrap();
    for case in corpus["derivatives"].as_array().unwrap() {
        let actual = TaskPerfProfile::decode(case["base"].as_str().unwrap().as_bytes())
            .and_then(|value| value.derivative());
        if case["error"].as_bool().unwrap() {
            assert!(actual.is_err(), "{}", case["name"]);
        } else {
            assert_eq!(
                String::from_utf8(actual.unwrap().encode()).unwrap(),
                case["expected"].as_str().unwrap(),
                "{}",
                case["name"]
            );
        }
    }
    for case in corpus["artifactComparisons"].as_array().unwrap() {
        let before = case["base"].as_str().unwrap().as_bytes();
        let selected = case["selected"].as_str().unwrap().as_bytes();
        let fixed = TaskPerfManifest::decode(
            &serde_json::to_vec(&manifest(before, selected)).unwrap(),
            PerfSystem::X86_64Linux,
        )
        .unwrap();
        assert_eq!(
            TaskPerfArtifactData::verify(fixed, before, selected).is_ok(),
            case["valid"].as_bool().unwrap(),
            "{}",
            case["name"]
        );
    }
}

#[test]
fn actual_python_raw_surrogate_pairs_preserve_two_codepoints_when_copied() {
    let corpus: Value =
        serde_json::from_str(include_str!("fixtures/task_perf/legacy-vectors.json")).unwrap();
    for case in corpus["byteArtifactComparisons"].as_array().unwrap() {
        let before = hex_bytes(case["baseHex"].as_str().unwrap());
        let selected = hex_bytes(case["selectedHex"].as_str().unwrap());
        assert_eq!(hash(&before), case["baseSHA256"].as_str().unwrap());
        assert_eq!(hash(&selected), case["selectedSHA256"].as_str().unwrap());
        let fixed = TaskPerfManifest::decode(
            &serde_json::to_vec(&manifest(&before, &selected)).unwrap(),
            PerfSystem::X86_64Linux,
        )
        .unwrap();
        assert_eq!(
            TaskPerfArtifactData::verify(fixed, &before, &selected).is_ok(),
            case["valid"].as_bool().unwrap(),
            "{}",
            case["name"]
        );
    }
}

fn hex_bytes(text: &str) -> Vec<u8> {
    text.as_bytes()
        .chunks_exact(2)
        .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
        .collect()
}

#[test]
fn closed_manifest_requires_real_version_supported_system_paths_and_lowercase_hash() {
    let base = base();
    let original = manifest(&base, &base);
    for change in [
        json!({"version":true}),
        json!({"version":1.0}),
        json!({"purpose":"task-v1"}),
        json!({"system":"aarch64-linux"}),
        json!({"baseSHA256":"A".repeat(64)}),
        json!({"extra":false}),
        json!({"profile":"/tmp/owner-input"}),
        json!({"profile":"/nix/store/base/../selected"}),
    ] {
        let mut modified = original.clone();
        modified
            .as_object_mut()
            .unwrap()
            .extend(change.as_object().unwrap().clone());
        assert!(
            TaskPerfManifest::decode(
                &serde_json::to_vec(&modified).unwrap(),
                PerfSystem::X86_64Linux
            )
            .is_err()
        );
    }
    assert_eq!(
        PerfSystem::from_linux_uname("Linux", "aarch64").unwrap(),
        PerfSystem::Aarch64Linux
    );
    for pair in [
        ("Darwin", "x86_64"),
        ("Linux", "ppc64le"),
        ("Windows", "aarch64"),
    ] {
        assert!(PerfSystem::from_linux_uname(pair.0, pair.1).is_err());
    }
    assert!(
        TaskPerfManifest::decode(br#"{"version":1,"version":1}"#, PerfSystem::X86_64Linux).is_err()
    );
}

#[test]
fn bounds_duplicates_and_legacy_byte_encodings_are_independent_of_profile_semantics() {
    assert!(matches!(
        TaskPerfProfile::decode(&vec![b' '; 65537]),
        Err(TaskPerfError::ArtifactBound)
    ));
    assert!(matches!(
        TaskPerfProfile::decode(br#"{"x":1,"\u0078":2}"#),
        Err(TaskPerfError::DuplicateKey)
    ));
    let raw = String::from_utf8(base()).unwrap();
    let expected = TaskPerfProfile::decode(raw.as_bytes()).unwrap();
    let mut forms = vec![[b"\xef\xbb\xbf".as_slice(), raw.as_bytes()].concat()];
    for little in [false, true] {
        let mut utf16 = if little {
            vec![255, 254]
        } else {
            vec![254, 255]
        };
        for value in raw.encode_utf16() {
            utf16.extend_from_slice(&if little {
                value.to_le_bytes()
            } else {
                value.to_be_bytes()
            });
        }
        let mut utf32 = if little {
            vec![255, 254, 0, 0]
        } else {
            vec![0, 0, 254, 255]
        };
        for value in raw.chars().map(u32::from) {
            utf32.extend_from_slice(&if little {
                value.to_le_bytes()
            } else {
                value.to_be_bytes()
            });
        }
        forms.extend([utf16, utf32]);
    }
    for bytes in forms {
        assert!(
            TaskPerfProfile::decode(&bytes)
                .unwrap()
                .equivalent(&expected)
        );
    }
}

#[test]
fn artifact_requires_both_exact_hashes_and_the_whole_single_derivative() {
    let before = base();
    let good = TaskPerfProfile::decode(&before)
        .unwrap()
        .derivative()
        .unwrap()
        .encode();
    for selected in [before.clone(), [good.as_slice(), b" " as &[u8]].concat()] {
        let fixed = TaskPerfManifest::decode(
            &serde_json::to_vec(&manifest(&before, &good)).unwrap(),
            PerfSystem::X86_64Linux,
        )
        .unwrap();
        assert!(TaskPerfArtifactData::verify(fixed, &before, &selected).is_err());
    }
    let mut extra: Value = serde_json::from_slice(&good).unwrap();
    extra["syscalls"]
        .as_array_mut()
        .unwrap()
        .push(json!({"names":["bpf"],"action":"SCMP_ACT_ALLOW"}));
    let extra = serde_json::to_vec(&extra).unwrap();
    let fixed = TaskPerfManifest::decode(
        &serde_json::to_vec(&manifest(&before, &extra)).unwrap(),
        PerfSystem::X86_64Linux,
    )
    .unwrap();
    assert!(matches!(
        TaskPerfArtifactData::verify(fixed, &before, &extra),
        Err(TaskPerfError::Derivative)
    ));
    assert!(
        TaskPerfProfile::decode(&good)
            .unwrap()
            .derivative()
            .is_err()
    );
}

#[test]
fn selected_projection_preserves_all_other_fields_and_never_grants_start_permission() {
    let fixed = artifact();
    let original = config(&fixed);
    let view = decode(&original);
    let chosen = view
        .project(
            Some(&ProfileEmployeeId::parse(EMPLOYEE).unwrap()),
            Some(&fixed),
        )
        .unwrap();
    assert!(chosen.selected());
    let mut expected = original.clone();
    expected
        .as_object_mut()
        .unwrap()
        .remove("employeePerfPolicies");
    expected["rootlessDocker"]["seccompProfile"] = SELECTED.into();
    expected["rootlessDocker"]["seccompSha256"] = fixed.manifest().profile_sha256().into();
    expected["_taskPerfPolicy"] = "task-v1".into();
    let actual: Value = serde_json::from_slice(&encode_config(chosen.configuration())).unwrap();
    assert_eq!(actual, expected);
    let selected = decode(&actual);
    selected.recognized(&fixed, fixed.selected()).unwrap();
    assert!(selected.recognized(&fixed, fixed.base()).is_err());
    let mut twice = actual;
    twice["employeePerfPolicies"] = json!({EMPLOYEE:"task-v1"});
    assert!(
        decode(&twice)
            .project(
                Some(&ProfileEmployeeId::parse(EMPLOYEE).unwrap()),
                Some(&fixed)
            )
            .is_err()
    );
    assert_eq!(original["rootlessDocker"]["seccompProfile"], BASE);
}

#[test]
fn empty_missing_and_other_employee_paths_need_no_artifact_or_policy_default() {
    let fixed = artifact();
    let original = config(&fixed);
    for employee in [None, Some(ProfileEmployeeId::parse(OTHER).unwrap())] {
        let projection = decode(&original).project(employee.as_ref(), None).unwrap();
        assert!(!projection.selected());
        let mut expected = original.clone();
        expected
            .as_object_mut()
            .unwrap()
            .remove("employeePerfPolicies");
        assert_eq!(
            serde_json::from_slice::<Value>(&encode_config(projection.configuration())).unwrap(),
            expected
        );
    }
    for input in [
        json!({}),
        json!({"employeePerfPolicies":{},"rootlessDocker":false}),
    ] {
        let view = decode(&input);
        assert!(!view.project(None, None).unwrap().selected());
    }
    assert!(
        decode(&original)
            .project(Some(&ProfileEmployeeId::parse(EMPLOYEE).unwrap()), None)
            .is_err()
    );
}

#[test]
fn policy_map_requires_exact_task_v1_ids_count_and_literal_rootless_true() {
    let fixed = artifact();
    let original = config(&fixed);
    for invalid in [
        Value::Null,
        json!([]),
        json!(true),
        json!({"name":"task-v1"}),
        json!({EMPLOYEE:true}),
        json!({EMPLOYEE:"unconfined"}),
    ] {
        let mut changed = original.clone();
        changed["employeePerfPolicies"] = invalid;
        assert!(TaskPerfConfiguration::decode(&serde_json::to_vec(&changed).unwrap()).is_err());
    }
    for enabled in [json!(false), json!(1), Value::Null] {
        let mut changed = original.clone();
        changed["rootlessDocker"]["enabled"] = enabled;
        assert!(TaskPerfConfiguration::decode(&serde_json::to_vec(&changed).unwrap()).is_err());
    }
    let mut changed = original;
    let entries = (0..257)
        .map(|i| {
            (
                format!("{i:08x}-0000-0000-0000-000000000000"),
                json!("task-v1"),
            )
        })
        .collect();
    changed["employeePerfPolicies"] = Value::Object(entries);
    assert!(TaskPerfConfiguration::decode(&serde_json::to_vec(&changed).unwrap()).is_err());
}

#[test]
fn fixed_base_and_marker_are_not_replaceable_by_a_forged_policy_or_profile() {
    let fixed = artifact();
    let original = config(&fixed);
    let employee = ProfileEmployeeId::parse(EMPLOYEE).unwrap();
    for field in ["seccompProfile", "seccompSha256"] {
        let mut changed = original.clone();
        changed["rootlessDocker"][field] = "different".into();
        assert!(
            decode(&changed)
                .project(Some(&employee), Some(&fixed))
                .is_err()
        );
    }
    assert!(
        decode(&original)
            .recognized(&fixed, fixed.selected())
            .is_err()
    );
    let projected = decode(&original)
        .project(Some(&employee), Some(&fixed))
        .unwrap();
    let mut changed: Value =
        serde_json::from_slice(&encode_config(projected.configuration())).unwrap();
    changed["_taskPerfPolicy"] = "forged".into();
    assert!(
        decode(&changed)
            .recognized(&fixed, fixed.selected())
            .is_err()
    );
}
