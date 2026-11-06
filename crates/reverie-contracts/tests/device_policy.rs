use reverie_contracts::device_policy::{gpu, memory};
use reverie_contracts::storage_identity::{self, CurrentEmployee};
use reverie_contracts::worker_config::{self, EffectiveWorkerConfig};
use reverie_core::ids::{ProfileEmployeeId, ProfileSessionId};
use reverie_core::resources::{BudgetMode, CpuQuota, ResourcePolicy};
use serde::Deserialize;

const E: &str = "11111111-1111-4111-8111-111111111111";
const S: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const D: &str = "nvidia.com/gpu=GPU-aBCDef12-3456-7890-ABcd-0123456789EF";
fn config(raw: &str) -> EffectiveWorkerConfig {
    worker_config::decode(raw.as_bytes()).unwrap()
}
fn employee(value: &str) -> ProfileEmployeeId {
    ProfileEmployeeId::parse(value).unwrap()
}
fn current(employee: &str, session: &str) -> CurrentEmployee {
    storage_identity::decode_metadata(format!("{{\"employees\":[{{\"id\":\"{employee}\",\"sessionId\":\"{session}\",\"sessionGeneration\":3}}]}}").as_bytes()).unwrap().current_employee(&self::employee(employee),&ProfileSessionId::parse(session).unwrap(),&None).unwrap().unwrap()
}
fn ram(memory: u32) -> ResourcePolicy {
    ResourcePolicy::try_new(
        if memory == 0 {
            BudgetMode::Pool
        } else {
            BudgetMode::Admission
        },
        memory,
        512,
        CpuQuota::from_float(1.0).unwrap(),
        8192,
        1024,
    )
    .unwrap()
}
#[derive(Deserialize)]
struct Corpus {
    cases: Vec<Case>,
}
#[derive(Deserialize)]
struct Case {
    name: String,
    input: String,
    resources: String,
    session: String,
    current_employee: Option<String>,
    storage_employee: Option<String>,
    checked_ram_mib: Option<u32>,
    output: String,
    config_sha256: String,
    policy_sha256: String,
    swap_bytes: u64,
    gpu_lookup: bool,
}

#[test]
fn actual_python_resource_config_bytes_and_hashes_match_all_feature_cases() {
    let corpus: Corpus =
        serde_json::from_str(include_str!("fixtures/device-policy-python-interop.json")).unwrap();
    assert_eq!(corpus.cases.len(), 19);
    for case in corpus.cases {
        let source = config(&case.input);
        let session = ProfileSessionId::parse(&case.session).unwrap();
        let mut resources = config(&case.resources);
        let observed = case
            .current_employee
            .as_ref()
            .map(|employee| current(employee, &case.session));
        if gpu::resource_projection_required(&source).unwrap() {
            let policies = gpu::validate_config(&source).unwrap();
            assert_eq!(
                policies.needs_current_employee(&session),
                case.gpu_lookup,
                "{} lookup",
                case.name
            );
            let grants = gpu::projected_gpu_grants(&policies, &session, observed.as_ref()).unwrap();
            resources = gpu::apply(resources, grants.as_ref());
        } else {
            assert!(!case.gpu_lookup);
        }
        let mut swap = 0;
        if memory::resource_projection_required(&source) {
            let policies = memory::validate(&source).unwrap();
            let storage = case.storage_employee.as_deref().map(employee);
            let effective = case.checked_ram_mib.map(ram);
            let projection =
                memory::project(&policies, resources, storage.as_ref(), effective.as_ref())
                    .unwrap();
            swap = projection.swap_bytes();
            resources = projection.into_configuration();
        }
        assert_eq!(
            worker_config::encode_config(&resources),
            case.output.as_bytes(),
            "{} bytes",
            case.name
        );
        assert_eq!(
            worker_config::config_digest(&resources).to_hex(),
            case.config_sha256,
            "{} config",
            case.name
        );
        assert_eq!(
            worker_config::policy_digest(&resources).to_hex(),
            case.policy_sha256,
            "{} policy",
            case.name
        );
        assert_eq!(swap, case.swap_bytes, "{} swap", case.name);
    }
}
#[test]
fn direct_gpu_shape_device_identity_and_combined_bounds_refuse() {
    for value in [
        "null",
        "false",
        "[]",
        "0",
        r#"{"not-uuid":"nvidia.com/gpu=all"}"#,
        &format!("{{\"{S}\":\"nvidia.com/gpu=all\"}}"),
        &format!("{{\"{S}\":true}}"),
        &format!("{{\"{S}\":\"{D}\",\"{S}\":\"{D}\"}}"),
    ] {
        assert!(gpu::validate_grants(value.as_bytes()).is_err(), "{value}");
    }
    let grants = serde_json::json!(
        (0..33)
            .map(|id| (format!("{id:08x}-0000-0000-0000-000000000000"), D))
            .collect::<std::collections::BTreeMap<_, _>>()
    );
    assert!(gpu::validate_grants(grants.to_string().as_bytes()).is_err());
    let legacy = (0..16)
        .map(|id| (format!("{id:08x}-0000-0000-0000-000000000000"), D))
        .collect::<std::collections::BTreeMap<_, _>>();
    let employees = (0..17)
        .map(|id| (format!("{id:08x}-0000-0000-0000-000000000000"), D))
        .collect::<std::collections::BTreeMap<_, _>>();
    assert!(
        gpu::validate_config(&config(
            &serde_json::json!({"gpuGrants":legacy,"employeeGpuGrants":employees}).to_string()
        ))
        .is_err()
    );
}
#[test]
fn direct_validation_is_not_applied_to_inactive_resource_config_fields() {
    for legacy in ["null", "false", "[]", "12"] {
        let source = config(&format!(
            "{{\"gpuGrants\":{legacy},\"employeeGpuGrants\":{{}}}}"
        ));
        assert!(!gpu::resource_projection_required(&source).unwrap());
        assert!(gpu::validate_config(&source).is_err());
    }
    for value in ["null", "false", "[]", "0", "\"\""] {
        assert!(
            gpu::resource_projection_required(&config(&format!(
                "{{\"employeeGpuGrants\":{value}}}"
            )))
            .is_err()
        );
    }
    for value in ["null", "false", "[]", "{}", "0", "-0.0", "\"\""] {
        let source = config(&format!(
            "{{\"employeeMemoryPolicies\":{value},\"laptopSwapPoolMiB\":true}}"
        ));
        assert!(!memory::resource_projection_required(&source), "{value}");
        assert!(memory::validate(&source).is_err());
    }
    for value in ["true", "1", "NaN", "[0]", "\"active\""] {
        let source = config(&format!("{{\"employeeMemoryPolicies\":{value}}}"));
        assert!(memory::resource_projection_required(&source));
        assert!(memory::validate(&source).is_err());
    }
}
#[test]
fn current_gpu_session_binding_is_checked_only_when_employee_lookup_is_needed() {
    let session = ProfileSessionId::parse(S).unwrap();
    let foreign = current(E, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    let policies = gpu::validate_config(&config(&format!(
        "{{\"employeeGpuGrants\":{{\"{E}\":\"{D}\"}}}}"
    )))
    .unwrap();
    assert!(gpu::projected_gpu_grants(&policies, &session, Some(&foreign)).is_err());
    let policies = gpu::validate_config(&config(&format!(
        "{{\"gpuGrants\":{{\"{S}\":\"{D}\"}},\"employeeGpuGrants\":{{\"{E}\":\"{D}\"}}}}"
    )))
    .unwrap();
    assert_eq!(
        gpu::gpu_create_args(&policies, &session, Some(&foreign)).unwrap(),
        [
            "--device",
            D,
            "--env",
            "LD_LIBRARY_PATH=/usr/local/nvidia/lib64:/usr/local/nvidia/lib"
        ]
    );
}
#[test]
fn memory_fields_types_bounds_and_required_swap_remain_closed() {
    for policy in [
        "{}",
        r#"{"memoryHighMiB":1024}"#,
        r#"{"swapMiB":true}"#,
        r#"{"swapMiB":1.0}"#,
        r#"{"swapMiB":-1}"#,
        r#"{"swapMiB":4097}"#,
        r#"{"swapMiB":0,"memoryHighMiB":511}"#,
        r#"{"swapMiB":0,"memoryHighMiB":1048577}"#,
        r#"{"swapMiB":0,"memoryHighMiB":true}"#,
        r#"{"swapMiB":0,"command":"forbidden"}"#,
    ] {
        let source = config(&format!(
            "{{\"employeeMemoryPolicies\":{{\"{E}\":{policy}}},\"laptopSwapPoolMiB\":4096}}"
        ));
        assert!(memory::validate(&source).is_err(), "{policy}");
    }
    for pool in ["-1", "true", "1.0", "1048577", "NaN"] {
        assert!(memory::validate(&config(&format!("{{\"laptopSwapPoolMiB\":{pool}}}"))).is_err());
    }
}
#[test]
fn only_selected_high_requires_a_matching_checked_integer_effective_ram() {
    let source = config(&format!(
        "{{\"employeeMemoryPolicies\":{{\"{E}\":{{\"memoryHighMiB\":1024,\"swapMiB\":1}}}},\"laptopSwapPoolMiB\":1}}"
    ));
    let policies = memory::validate(&source).unwrap();
    for raw in [
        r#"{"memoryMiB":2048.0}"#,
        r#"{"memoryMiB":true}"#,
        r#"{"memoryMiB":Infinity}"#,
        r#"{"memoryMiB":4096}"#,
    ] {
        assert!(
            memory::project(&policies, config(raw), Some(&employee(E)), Some(&ram(2048))).is_err(),
            "{raw}"
        );
    }
    assert!(
        memory::project(
            &policies,
            config(r#"{"memoryMiB":2048}"#),
            Some(&employee(E)),
            None
        )
        .is_err()
    );
    assert!(
        memory::project(
            &policies,
            config(r#"{"memoryMiB":1024}"#),
            Some(&employee(E)),
            Some(&ram(1024))
        )
        .is_err()
    );
    let unselected =
        memory::project(&policies, config(r#"{"memoryMiB":NaN}"#), None, None).unwrap();
    assert_eq!(
        worker_config::encode_config(unselected.configuration()),
        b"{\"memoryMiB\": NaN}"
    );
    let policies = memory::validate(&config(&format!(
        "{{\"employeeMemoryPolicies\":{{\"{E}\":{{\"swapMiB\":0}}}}}}"
    )))
    .unwrap();
    assert!(
        memory::project(
            &policies,
            config(r#"{"memoryMiB":NaN}"#),
            Some(&employee(E)),
            None
        )
        .is_ok()
    );
}
#[test]
fn general_device_projection_inherits_neither_stage_clone_bound_nor_global_finite_guard() {
    let source = config(&format!(
        "{{\"employeeGpuGrants\":{{\"{E}\":\"{D}\"}},\"padding\":\"{}\",\"opaque\":NaN}}",
        "x".repeat(140_000)
    ));
    let policies = gpu::validate_config(&source).unwrap();
    let sid = ProfileSessionId::parse(S).unwrap();
    let observed = current(E, S);
    let grants = gpu::projected_gpu_grants(&policies, &sid, Some(&observed)).unwrap();
    let output = gpu::apply(source, grants.as_ref());
    assert!(worker_config::encode_config(&output).len() > 131_072);
    let source = config(&format!(
        "{{\"employeeMemoryPolicies\":{{\"{E}\":{{\"swapMiB\":0}}}},\"padding\":\"{}\",\"opaque\":NaN}}",
        "x".repeat(140_000)
    ));
    let policies = memory::validate(&source).unwrap();
    let output = memory::project(&policies, source, Some(&employee(E)), None).unwrap();
    assert!(worker_config::encode_config(output.configuration()).len() > 131_072);
}
