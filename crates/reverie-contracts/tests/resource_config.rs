use reverie_contracts::{device_policy::gpu, resource_config, task_perf_v1, worker_config};
use reverie_core::ids::{ProfileEmployeeId, ProfileSessionId};
use serde::Deserialize;

#[derive(Deserialize)]
struct Corpus {
    cases: Vec<Case>,
}
#[derive(Deserialize)]
struct Case {
    name: String,
    input: String,
    session: String,
    employee: Option<String>,
    output: Option<String>,
    policy_sha256: Option<String>,
    #[serde(default)]
    refused: bool,
}
#[test]
fn actual_python_resource_selection_control_stripping_and_perf_input_order_match() {
    let corpus: Corpus =
        serde_json::from_str(include_str!("fixtures/resource-config-python-interop.json")).unwrap();
    assert_eq!(corpus.cases.len(), 23);
    for case in corpus.cases {
        let resolve = || -> Result<_, Box<dyn std::error::Error>> {
            let data = resource_config::ResourceConfiguration::capture(worker_config::decode(
                case.input.as_bytes(),
            )?)?;
            let session = ProfileSessionId::parse(&case.session)?;
            let employee = case
                .employee
                .as_deref()
                .map(ProfileEmployeeId::parse)
                .transpose()?;
            // These cases exercise the actual inactive-feature callsites. Native
            // feature observations are tested independently and by the service.
            assert!(!gpu::resource_projection_required(data.source())?);
            let base = data.project(&session, employee.as_ref())?;
            let perf = task_perf_v1::TaskPerfConfiguration::for_resources(data.source(), base)?;
            Ok(perf.project(None, None)?.into_configuration())
        };
        let result = resolve();
        if case.refused {
            assert!(result.is_err(), "{}", case.name);
        } else {
            let result = result.unwrap_or_else(|e| panic!("{}: {e}", case.name));
            assert_eq!(
                worker_config::encode_config(&result),
                case.output.unwrap().as_bytes(),
                "{}",
                case.name
            );
            assert_eq!(
                worker_config::policy_digest(&result).to_hex(),
                case.policy_sha256.unwrap(),
                "{}",
                case.name
            );
        }
    }
}
#[test]
fn native_identity_settings_come_from_the_same_captured_data_without_lossy_paths() {
    let raw = br#"{"companyFile":"/owned/company.json","stateRoot":"/owned/state","scratchRoot":"/owned/\udcff","uid":1234}"#;
    let captured =
        resource_config::ResourceConfiguration::capture(worker_config::decode(raw).unwrap())
            .unwrap();
    let paths = captured.identity_settings().unwrap();
    assert_eq!(paths.uid(), 1234);
    assert_eq!(
        paths.company_file().scalar_text().unwrap(),
        "/owned/company.json"
    );
    assert_eq!(paths.state_root().scalar_text().unwrap(), "/owned/state");
    assert_eq!(paths.scratch_root().codepoints().last(), Some(&0xdcff));
    assert!(paths.scratch_root().scalar_text().is_none());
}
#[test]
fn base_projection_reuses_checked_fields_and_never_limits_opaque_worker_data() {
    let raw = format!(
        "{{\"opaque\":\"{}\",\"employeeResources\":{{}}}}",
        "x".repeat(140000)
    );
    let data = resource_config::ResourceConfiguration::capture(
        worker_config::decode(raw.as_bytes()).unwrap(),
    )
    .unwrap();
    let sid = ProfileSessionId::parse("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa").unwrap();
    assert!(!data.needs_storage_employee(&sid));
    let base = data.project(&sid, None).unwrap();
    assert!(worker_config::encode_config(&base).len() > 131072);
    assert!(resource_config::checked_effective_policy(&base).is_err());
    assert!(data.identity_settings().is_err());
}
