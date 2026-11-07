use reverie_contracts::{
    command_telemetry as telemetry, storage_identity::MetadataText, worker_config,
};
use reverie_core::{
    PythonText,
    command_telemetry::{
        EmployeeFailureReport, FailureCount, FailureExit, FailureReport, FailureReportRequest,
        FailureTool, TelemetryConfiguration,
    },
    ids::ProfileEmployeeId,
    worker_options::TelemetryKey,
};
use serde_json::{Value, json};
fn corpus() -> Value {
    serde_json::from_str(include_str!("fixtures/command-telemetry/legacy.json")).unwrap()
}
fn text(points: &Value) -> MetadataText {
    MetadataText::from_python_text(
        PythonText::try_new(serde_json::from_value(points.clone()).unwrap()).unwrap(),
    )
}
#[test]
fn actual_python_optional_configuration_and_closed_final_argv_sources() {
    let corpus = corpus();
    for case in corpus["configuration"].as_array().unwrap() {
        let config = worker_config::decode(case["input"].as_str().unwrap().as_bytes()).unwrap();
        let actual = telemetry::configuration(&config)
            .map(|policy| {
                json!([
                    policy.enabled(),
                    policy
                        .keys()
                        .iter()
                        .map(|key| key.as_str())
                        .collect::<Vec<_>>()
                ])
            })
            .ok();
        assert_eq!(
            actual,
            (!case["output"].is_null()).then(|| case["output"].clone()),
            "{case}"
        );
    }
    for case in corpus["argv"].as_array().unwrap() {
        let args = case["input"]
            .as_array()
            .unwrap()
            .iter()
            .map(text)
            .collect::<Vec<_>>();
        let actual = telemetry::create_sources(&args)
            .map(|sources| {
                json!(
                    sources
                        .iter()
                        .map(MetadataText::codepoints)
                        .collect::<Vec<_>>()
                )
            })
            .ok();
        assert_eq!(
            actual,
            (!case["output"].is_null()).then(|| case["output"].clone()),
            "{case}"
        );
    }
}
#[test]
fn actual_python_filtered_engine_census_and_complete_inspect_shape() {
    let corpus = corpus();
    for case in corpus["inventory"].as_array().unwrap() {
        let actual = telemetry::inventory_ids(case["input"].as_str().unwrap())
            .map(|ids| json!(ids.iter().map(|id| id.as_str()).collect::<Vec<_>>()))
            .ok();
        assert_eq!(
            actual,
            (!case["output"].is_null()).then(|| case["output"].clone()),
            "{case}"
        );
    }
    for case in corpus["inspect"].as_array().unwrap() {
        let actual = telemetry::inspect_sources(case["input"].as_str().unwrap())
            .map(|paths| {
                json!(
                    paths
                        .iter()
                        .map(MetadataText::codepoints)
                        .collect::<Vec<_>>()
                )
            })
            .ok();
        assert_eq!(
            actual,
            (!case["output"].is_null()).then(|| case["output"].clone()),
            "{case}"
        );
    }
}
#[test]
fn actual_python_byte_events_and_protected_report_requests() {
    let corpus = corpus();
    for case in corpus["event"].as_array().unwrap() {
        let raw: Vec<u8> = serde_json::from_value(case["input"].clone()).unwrap();
        let actual = telemetry::decode_event(&raw, &[TelemetryKey::Shell])
            .map(|event| {
                json!([
                    event.tool().as_str(),
                    event.exit().get(),
                    event.execution().as_str()
                ])
            })
            .ok();
        assert_eq!(
            actual,
            (!case["output"].is_null()).then(|| case["output"].clone()),
            "{case}"
        );
    }
    for case in corpus["request"].as_array().unwrap() {
        let raw: Vec<u8> = serde_json::from_value(case["input"].clone()).unwrap();
        let actual = telemetry::decode_report_request(&raw)
            .map(|request| {
                json!(
                    request
                        .employees()
                        .iter()
                        .map(|id| id.as_str())
                        .collect::<Vec<_>>()
                )
            })
            .ok();
        assert_eq!(
            actual,
            (!case["output"].is_null()).then(|| case["output"].clone()),
            "{case}"
        );
    }
}
#[test]
fn actual_python_report_bytes_and_unavailable_corrupt_aggregate() {
    for case in corpus()["reports"].as_array().unwrap() {
        let raw = &case["input"];
        let employee = ProfileEmployeeId::parse(raw["employee_id"].as_str().unwrap()).unwrap();
        let policy = TelemetryConfiguration::try_new(
            case["enabled"].as_bool().unwrap(),
            vec![TelemetryKey::Shell],
        )
        .unwrap();
        let counts = raw["counts"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| {
                FailureCount::try_new(
                    FailureTool::parse(row["tool"].as_str().unwrap()).unwrap(),
                    FailureExit::try_new(i16::try_from(row["exit"].as_i64().unwrap()).unwrap())
                        .unwrap(),
                    u32::try_from(row["count"].as_u64().unwrap()).unwrap(),
                )
                .unwrap()
            })
            .collect();
        let report = FailureReport::new(employee.clone(), counts, 3, 4, 5);
        let observed = match case["status"].as_str().unwrap() {
            "ready" => EmployeeFailureReport::Ready(report),
            "no_data" => EmployeeFailureReport::NoData,
            _ => EmployeeFailureReport::Unavailable,
        };
        let request = FailureReportRequest::try_new(vec![employee]).unwrap();
        assert_eq!(
            telemetry::build_report(&policy, &request, &[observed]).unwrap(),
            case["output"].as_str().unwrap().as_bytes()
        );
    }
}
