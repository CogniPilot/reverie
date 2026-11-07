//! Original unmodified Python replies/call outcomes, with frozen process fields
//! used only as DATA. No process observation, signal, source lease or authority.
use reverie_contracts::{
    reservation_baseline::{OriginalBaselineFields, OriginalRuntimeTail, OriginalSourceBaseline},
    reservation_engine::{InventoryRows, NativeLimitBinding},
    worker_config,
    worker_schema::WorkerEnvelope,
    worker_source_stop::{SourceStopInspection, SourceStopName},
};
use reverie_core::{decimal::UnsignedInteger, ids::ContainerId, posix_path::PosixPath};
use serde_json::{Value, json};
fn corpus() -> Value {
    serde_json::from_str(include_str!("fixtures/source-stop-python.json")).unwrap()
}
fn baseline(corpus: &Value, name: Option<&str>) -> OriginalSourceBaseline {
    let mut rows: Value =
        serde_json::from_str(corpus["cases"][0]["before"].as_str().unwrap()).unwrap();
    let row = &mut rows[0];
    if let Some(name) = name {
        row["Name"] = json!(name);
    }
    // This baseline-only wrapper needs the shared finite-limit schema. Keep
    // every original Python before/after/final payload unchanged below.
    row["HostConfig"]["Memory"] = json!(512 * 1_048_576);
    row["HostConfig"]["MemorySwap"] = json!(512 * 1_048_576);
    row["HostConfig"]["PidsLimit"] = json!(128);
    row["HostConfig"]["NanoCpus"] = json!(0);
    let id = ContainerId::parse(row["Id"].as_str().unwrap()).unwrap();
    let decoded = InventoryRows::decode(&[id], &[row.to_string()]).unwrap();
    let row = &decoded.rows()[0];
    let zero = UnsignedInteger::from_u64(0);
    let limits = NativeLimitBinding::from_observed_data(
        row,
        &row.declarations(&zero).unwrap(),
        corpus["ownedStart"].as_str().unwrap(),
        &PosixPath::from_scalar_text("owned-fixture"),
        None,
    )
    .unwrap();
    OriginalSourceBaseline::from_observed_data(OriginalBaselineFields {
        source: row,
        native: &limits,
        storage: &reverie_contracts::reservation_engine::NativeStorageBinding::from_observed_data(
            [[1, 1, 1000, 100]; 3],
        ),
        site: &limits,
        commitments: &[],
        total: &zero,
        budget: &zero,
        runtime: &OriginalRuntimeTail::from_observed_data([1, 1], vec![]),
    })
}
#[test]
fn exact_original_stop_json_and_metadata_equality_match_thirty_two_actual_python_vectors() {
    let data = corpus();
    let config = worker_config::decode(&serde_json::to_vec(&data["config"]).unwrap()).unwrap();
    let envelope = WorkerEnvelope::capture(config.clone()).unwrap();
    let baseline = baseline(&data, None);
    let name = SourceStopName::from_baseline(envelope.base(), &baseline).unwrap();
    let policy = worker_config::policy_digest(&config);
    let cases = data["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 32);
    for case in cases {
        let result = SourceStopInspection::identity(
            case["before"].as_str().unwrap().as_bytes(),
            &name,
            name.container(),
            envelope.base().deployment(),
        )
        .and_then(|before| {
            before.assert_policy(&policy)?;
            let state = before.state()?;
            let expected = &case["expectedProcess"];
            let expected_pid = expected["pid"].to_string();
            if !expected.is_null() && state.pid().as_str() != expected_pid {
                return Ok(false);
            }
            if !state.running() {
                return Ok(true);
            }
            let snapshot = before.metadata();
            let after = snapshot.observe(
                case["after"].as_str().unwrap().as_bytes(),
                case["afterExit"] == 0,
            )?;
            if !after.running() {
                return Ok(after.pid().is_zero());
            }
            if after.pid() != state.pid() {
                return Ok(false);
            }
            let last = snapshot.observe(case["final"].as_str().unwrap().as_bytes(), true)?;
            Ok(!last.running() && last.pid().is_zero())
        })
        .unwrap_or(false);
        assert_eq!(
            result,
            case["accepted"].as_bool().unwrap(),
            "{}",
            case["name"]
        );
    }
}
#[test]
fn original_raw_baseline_name_cannot_redirect_legacy_bare_membership() {
    let data = corpus();
    let config = worker_config::decode(&serde_json::to_vec(&data["config"]).unwrap()).unwrap();
    let envelope = WorkerEnvelope::capture(config).unwrap();
    let expected = data["name"].as_str().unwrap();
    for raw in [expected.to_owned(), format!("/{expected}")] {
        let baseline = baseline(&data, Some(&raw));
        assert_eq!(
            SourceStopName::from_baseline(envelope.base(), &baseline)
                .unwrap()
                .name()
                .as_str(),
            expected
        );
    }
    for raw in [
        data["session"].as_str().unwrap().to_owned(),
        format!("//{expected}"),
        "foreign-agent-11111111-2222-3333-4444-555555555555".to_owned(),
    ] {
        assert!(
            SourceStopName::from_baseline(envelope.base(), &baseline(&data, Some(&raw))).is_err()
        );
    }
}
