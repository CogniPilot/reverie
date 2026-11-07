use reverie_contracts::gpu_access;
use reverie_core::{
    device_policy::{GpuPolicies, NvidiaCdiDevice},
    gpu_access::{
        GpuActiveData, GpuApplied, GpuBinding, GpuChoice, GpuChoicesData, GpuDeviceUuid,
        GpuQueuedRequest, GpuStatusData,
    },
    ids::{ProfileEmployeeId, ProfileSessionId},
    operations::{JournalDigest, JournalId},
    revision::Generation,
};
use serde_json::Value;
use std::collections::BTreeMap;
fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap()
}
fn status(value: &Value) -> GpuStatusData {
    let employee = JournalId::parse(text(value, "employeeId")).unwrap();
    let session = ProfileSessionId::parse(text(&value["current"], "sessionId")).unwrap();
    let generation =
        Generation::try_new(value["current"]["sessionGeneration"].as_u64().unwrap()).unwrap();
    let digest = JournalDigest::parse(&"a".repeat(64)).unwrap();
    let current = GpuBinding::new(session.clone(), generation, digest.clone());
    let request = (!value["requested"].is_null()).then(|| {
        GpuQueuedRequest::try_new(
            value["revision"].as_u64().unwrap(),
            JournalId::parse(session.as_str()).unwrap(),
            generation,
            digest.clone(),
            value["requested"]["deviceUuid"]
                .as_str()
                .map(|value| GpuDeviceUuid::parse(value).unwrap()),
        )
        .unwrap()
    });
    let choices = GpuChoicesData::known(
        value["choices"]["devices"]
            .as_array()
            .unwrap()
            .iter()
            .map(|device| {
                GpuChoice::try_new(
                    GpuDeviceUuid::parse(text(device, "deviceUuid")).unwrap(),
                    text(device, "model").to_owned(),
                )
                .unwrap()
            })
            .collect(),
    )
    .unwrap();
    let mut legacy = BTreeMap::new();
    let mut employees = BTreeMap::new();
    if let Some(device) = value["applied"]["deviceUuid"].as_str() {
        let device = NvidiaCdiDevice::parse(&format!("nvidia.com/gpu={device}")).unwrap();
        if text(&value["applied"], "source") == "legacy-session" {
            legacy.insert(session.clone(), device);
        } else {
            employees.insert(ProfileEmployeeId::parse(employee.as_str()).unwrap(), device);
        }
    }
    let policies = GpuPolicies::try_new(Some(legacy), employees).unwrap();
    let applied = GpuApplied::project(
        &policies,
        &session,
        &ProfileEmployeeId::parse(employee.as_str()).unwrap(),
    );
    let active = if !value["active"]["running"].as_bool().unwrap() {
        GpuActiveData::Stopped
    } else if value["active"]["known"] == false {
        GpuActiveData::UnknownRunning
    } else {
        GpuActiveData::ObservedDevice(
            GpuDeviceUuid::parse(text(&value["active"], "deviceUuid")).unwrap(),
        )
    };
    GpuStatusData::new(employee, current, request, choices, applied, active).unwrap()
}
#[test]
fn six_actual_owner_status_request_replies_preserve_exact_default_json_bytes() {
    let corpus: Value =
        serde_json::from_str(include_str!("fixtures/gpu_access/status.json")).unwrap();
    let cases = corpus["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 6);
    for case in cases {
        let status = status(&case["value"]);
        let expected = text(case, "bytes").replace("@BINDING@", &"a".repeat(64));
        assert_eq!(
            gpu_access::encode_status(&status),
            expected.as_bytes(),
            "{}",
            text(case, "name")
        );
    }
}
