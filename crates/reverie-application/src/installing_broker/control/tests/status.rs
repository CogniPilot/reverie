//! Genuine accepted C plus the existing fixed Rust metadata child. No live
//! engine, callback, manufactured runtime or lifecycle mutation is selected.
use super::*;
type Response = Result<(u8, serde_json::Value), String>;
type Observation = (Result<(), String>, Response, String);

#[test]
fn storage_status_reads_original_registry_without_native_commands() {
    crate::test_process::owning_case!(
        storage_status_reads_original_registry_without_native_commands
    );
    let (body, response, calls) = observe(br#"{"action":"storage-status"}"#, "");
    body.unwrap();
    assert_eq!(
        response.unwrap(),
        (
            b'J',
            serde_json::json!({"storageStatus":{
                "version":1,"purpose":"worker-storage-owner-status-v1",
                "readOnly":true,"completeSnapshot":false,"entries":[]
            }})
        )
    );
    assert!(
        calls.is_empty(),
        "read-only registry projection issued a native command"
    );
}

#[test]
fn storage_status_wire_projects_held_owner_without_paths_principal_or_release() {
    crate::test_process::owning_case!(
        storage_status_wire_projects_held_owner_without_paths_principal_or_release
    );
    let (root, broker) = recovered::tests::Tree::bootstrap_parts("", "admission", 512, 4096);
    let sid = ProfileSessionId::parse("bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee").unwrap();
    let company = serde_json::json!({"employees":[{
        "id":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee","sessionId":sid.as_str(),
        "sessionGeneration":3,"owner":"fixture-private-principal",
        "desiredRunning":true,"onVacation":false
    }]});
    std::fs::write(
        root.join("company.json"),
        serde_json::to_vec(&company).unwrap(),
    )
    .unwrap();
    let broker = Arc::new(broker);
    let snapshot = broker.configuration().unwrap();
    let claim = broker
        .storage
        .claim(snapshot.configuration(), &sid)
        .unwrap();
    let calls_before = std::fs::read(root.join("calls.txt")).unwrap_or_default();
    let (mut client, connection) = incoming(&broker, br#"{"action":"storage-status"}"#);
    let result = broker.handle_control(connection).map_err(|mut failure| {
        let _ = failure.reconcile();
        failure.to_string()
    });
    let response = reply(&mut client);
    let calls_after = std::fs::read(root.join("calls.txt")).unwrap_or_default();
    let metadata = reverie_contracts::storage_identity::decode_metadata(
        &std::fs::read(root.join("company.json")).unwrap(),
    )
    .unwrap();
    let retained = broker.storage.storage_status(&metadata).unwrap().len();
    claim
        .release(Instant::now() + Duration::from_secs(3))
        .unwrap();
    finish(root.clone(), broker, client).unwrap();
    result.unwrap();
    let (kind, value) = response.unwrap();
    assert_eq!(kind, b'J');
    let row = &value["storageStatus"]["entries"][0];
    assert_eq!(row["sessionId"], sid.as_str());
    assert_eq!(row["currentSessionGeneration"], "3");
    assert_eq!(row["ownerKind"], "direct");
    assert_eq!(row["writerChecked"], true);
    assert!(row.get("ownerSessionGeneration").is_none());
    let raw = serde_json::to_string(&value).unwrap();
    assert!(!raw.contains(root.to_str().unwrap()));
    assert!(!raw.contains("fixture-private-principal"));
    assert_eq!(calls_before, calls_after);
    assert_eq!(retained, 1);
}

fn reply(client: &mut UnixStream) -> Response {
    let mut header = [0; 5];
    client.read_exact(&mut header).map_err(|e| e.to_string())?;
    let header = WorkerFrameHeader::decode(header);
    let mut raw = vec![0; header.payload_length() as usize];
    client.read_exact(&mut raw).map_err(|e| e.to_string())?;
    serde_json::from_slice(&raw)
        .map(|value| (header.kind(), value))
        .map_err(|e| format!("{}: {e}", String::from_utf8_lossy(&raw)))
}
fn observe(request: &[u8], names: &str) -> Observation {
    observe_company(request, names, None)
}
fn observe_company(request: &[u8], names: &str, company: Option<serde_json::Value>) -> Observation {
    let (root, broker) = recovered::tests::Tree::bootstrap_parts("", "admission", 512, 4096);
    std::fs::write(root.join("names.out"), names).unwrap();
    if let Some(company) = company {
        std::fs::write(
            root.join("company.json"),
            serde_json::to_vec(&company).unwrap(),
        )
        .unwrap();
    }
    let broker = Arc::new(broker);
    let (mut client, connection) = incoming(&broker, request);
    let result = broker.handle_control(connection).map_err(|mut failure| {
        let _ = failure.reconcile();
        failure.to_string()
    });
    let response = reply(&mut client);
    let calls = std::fs::read_to_string(root.join("calls.txt")).unwrap_or_default();
    let closed = finish(root, broker, client);
    closed.unwrap();
    (result, response, calls)
}

#[test]
fn actual_current_company_binding_stays_unknown_without_native_command_proof() {
    crate::test_process::owning_case!(
        actual_current_company_binding_stays_unknown_without_native_command_proof
    );
    let employee = serde_json::json!({"id":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        "sessionId":"bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee","sessionGeneration":3,
        "owner":"fixture-owner","desiredRunning":true,"onVacation":false,
        "runtimeRecipe":{"mode":"codex"},"permissions":{}});
    let (body, response, calls) = observe_company(
        br#"{"action":"provider-health"}"#,
        "",
        Some(serde_json::json!({"employees":[employee]})),
    );
    body.unwrap();
    let (kind, value) = response.unwrap();
    assert_eq!(kind, b'J');
    let rows = value["providerHealth"]["providers"].as_array().unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["state"], "unknown");
    assert_eq!(rows[0]["reason"], "UNCONFIRMED");
    assert_eq!(
        rows[0]["observedBinding"],
        serde_json::json!([
            employee["id"],
            employee["owner"],
            employee["sessionId"],
            3,
            true,
            false,
            null,
            employee["runtimeRecipe"],
            employee["permissions"]
        ])
    );
    assert!(rows[0].get("containerId").is_none());
    assert!(rows[0]["observedAtEpochMs"].as_u64().is_some());
    assert!(
        calls
            .lines()
            .all(|line| !line.starts_with("stop\0") && !line.starts_with("rm\0"))
    );
}

#[test]
fn actual_empty_status_is_read_only_and_keeps_the_existing_response_shape() {
    crate::test_process::owning_case!(
        actual_empty_status_is_read_only_and_keeps_the_existing_response_shape
    );
    let (body, response, calls) = observe(br#"{"action":"status"}"#, "");
    body.unwrap();
    assert_eq!(
        response.unwrap(),
        (
            b'J',
            serde_json::json!({"runningLaptops":0,
        "runningSessionIds":[],"offlineGraceSeconds":600})
        )
    );
    assert!(
        calls
            .lines()
            .all(|line| !line.starts_with("stop\0") && !line.starts_with("rm\0"))
    );
    assert!(calls.lines().any(|line| line.starts_with("ps\0")));
}
#[test]
fn actual_empty_company_health_returns_no_fabricated_provider_or_ready_flag() {
    crate::test_process::owning_case!(
        actual_empty_company_health_returns_no_fabricated_provider_or_ready_flag
    );
    let (body, response, calls) = observe(br#"{"action":"provider-health"}"#, "");
    body.unwrap();
    assert_eq!(
        response.unwrap(),
        (
            b'J',
            serde_json::json!({"providerHealth":{
        "version":1,"purpose":"worker-provider-health-v1","providers":[]}})
        )
    );
    assert!(
        calls
            .lines()
            .all(|line| !line.starts_with("stop\0") && !line.starts_with("rm\0"))
    );
}
#[test]
fn validated_unsupported_stop_returns_definitive_nondispatch_without_any_native_call() {
    crate::test_process::owning_case!(
        validated_unsupported_stop_returns_definitive_nondispatch_without_any_native_call
    );
    let (body, response, calls) = observe(br#"{"action":"stop-agent","sessionId":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee","notAfter":1800000000000,"fence":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}"#, "");
    body.unwrap();
    let (kind, value) = response.unwrap();
    assert_eq!(kind, b'J');
    assert_eq!(value["action"], "stop-agent");
    assert_eq!(value["success"], false);
    assert_eq!(value["dispatched"], false);
    assert!(value.get("stopped").is_none());
    assert!(value.get("paneDead").is_none());
    assert!(calls.is_empty());
}
#[test]
fn malformed_native_status_census_never_returns_a_successful_inventory() {
    crate::test_process::owning_case!(
        malformed_native_status_census_never_returns_a_successful_inventory
    );
    let (body, response, calls) = observe(br#"{"action":"status"}"#, "foreign-container\n");
    assert!(body.is_err());
    assert!(response.is_err());
    assert!(calls.lines().any(|line| line.starts_with("ps\0")));
    assert!(
        calls
            .lines()
            .all(|line| !line.starts_with("stop\0") && !line.starts_with("rm\0"))
    );
}
