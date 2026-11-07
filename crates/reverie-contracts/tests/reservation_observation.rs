use reverie_contracts::{
    profiles_v1,
    reservation_observation::{
        ReservationEmployee, ReservationObservation, ReservationObservationFields,
    },
    storage_identity::decode_metadata,
    worker_config,
};
use reverie_core::{
    ids::{ProfileEmployeeId, ProfileSessionId},
    operations::{JournalDigest, JournalId, MemoryBytes},
    resources::CpuQuota,
    revision::{Generation, ProfileVersion},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
fn sha(raw: &[u8]) -> String {
    Sha256::digest(raw)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
fn oracle() -> Value {
    serde_json::from_str(include_str!("fixtures/reservation-observe-python.json")).unwrap()
}
fn profile(value: &Value) -> reverie_core::profiles::ResourceProfile {
    let eid = value["binding"]["employee_id"].as_str().unwrap();
    let mut profiles = serde_json::Map::new();
    profiles.insert(eid.to_owned(), value.clone());
    let raw = serde_json::to_vec(
        &json!({"schema":"reverie-employee-resource-profiles-v1","revision":1,"profiles":profiles}),
    )
    .unwrap();
    profiles_v1::decode(&raw)
        .unwrap()
        .profiles()
        .values()
        .next()
        .unwrap()
        .clone()
}
#[test]
fn all_five_hundred_original_float_witnesses_have_exact_python_nano_cpu_values() {
    let original = include_bytes!("fixtures/valid-cpu-floats.json");
    let values: Value = serde_json::from_slice(original).unwrap();
    let expected: Value =
        serde_json::from_str(include_str!("fixtures/reservation-cpu-nano-python.json")).unwrap();
    assert_eq!(sha(original), expected["sourceSha256"].as_str().unwrap());
    let values = values.as_array().unwrap();
    let cases = expected["cases"].as_array().unwrap();
    assert_eq!(values.len(), 500);
    assert_eq!(cases.len(), values.len());
    for (value, expected) in values.iter().zip(cases) {
        assert_eq!(value["name"], expected["name"]);
        let bits = u64::from_str_radix(value["f64_bits"].as_str().unwrap(), 16).unwrap();
        assert_eq!(
            CpuQuota::from_float(f64::from_bits(bits))
                .unwrap()
                .nano_cpus(),
            expected["nano"].as_u64().unwrap(),
            "{}",
            value["name"]
        );
    }
    for edge in expected["edges"].as_array().unwrap() {
        let quota = match edge["integer"].as_u64() {
            Some(integer) => CpuQuota::from_integer(integer).unwrap(),
            None => CpuQuota::from_float(f64::from_bits(
                u64::from_str_radix(edge["floatBits"].as_str().unwrap(), 16).unwrap(),
            ))
            .unwrap(),
        };
        assert_eq!(quota.nano_cpus(), edge["nano"].as_u64().unwrap());
    }
}
#[test]
fn legacy_profile_equality_keeps_numeric_cpu_equivalence_separate_from_digest_identity() {
    let original = oracle()["profile"].clone();
    let integer = profile(&original);
    for cpu in [json!(0.0), json!(-0.0)] {
        let mut changed = original.clone();
        changed["resources"]["cpus"] = cpu;
        let float = profile(&changed);
        assert_ne!(integer, float);
        assert!(profiles_v1::equivalent(&integer, &float));
        assert_ne!(
            profiles_v1::profile_digest(&integer).unwrap(),
            profiles_v1::profile_digest(&float).unwrap()
        );
    }
    let mut changed = original;
    changed["resources"]["memoryMiB"] = json!(1536);
    assert!(!profiles_v1::equivalent(&integer, &profile(&changed)));
}
#[test]
fn current_employee_is_original_row_data_and_generation_validation_is_delayed() {
    let oracle = oracle();
    let row = oracle["employee"].clone();
    let eid = ProfileEmployeeId::parse(row["id"].as_str().unwrap()).unwrap();
    let sid = ProfileSessionId::parse(row["sessionId"].as_str().unwrap()).unwrap();
    let read = |row: &Value| {
        decode_metadata(&serde_json::to_vec(&json!({"employees":[row]})).unwrap()).unwrap()
    };
    let employee = ReservationEmployee::select(&read(&row), &eid, &sid).unwrap();
    assert_eq!(
        employee
            .owner_scope_digest(&JournalId::parse(oracle["company"].as_str().unwrap()).unwrap())
            .unwrap()
            .as_str(),
        oracle["ownerScopeDigest"].as_str().unwrap()
    );
    assert!(employee.still_current(&read(&row)).unwrap());
    let mut changed = row.clone();
    changed["extra"] = json!("different");
    assert!(!employee.still_current(&read(&changed)).unwrap());
    for generation in [
        json!(true),
        json!(1.0),
        json!(0),
        json!(9_007_199_254_740_992u64),
    ] {
        let mut value = row.clone();
        value["sessionGeneration"] = generation;
        let selected = ReservationEmployee::select(&read(&value), &eid, &sid).unwrap();
        assert_eq!(
            selected.generation().unwrap_err().code(),
            "RESERVATION_GENERATION"
        );
    }
    assert_eq!(employee.generation().unwrap().get(), 1);
}
#[test]
fn nil_profile_namespaces_remain_readable_and_journal_roles_are_checked_at_conversion() {
    let nil = "00000000-0000-0000-0000-000000000000";
    let fields = ReservationObservationFields {
        pool: JournalId::parse("55555555-2222-4333-8444-555555555555").unwrap(),
        pool_revision: JournalDigest::parse(&"a".repeat(64)).unwrap(),
        budget_bytes: 4096 * 1_048_576,
        committed_bytes: 512 * 1_048_576,
        employee: ProfileEmployeeId::parse(nil).unwrap(),
        current_session: ProfileSessionId::parse(nil).unwrap(),
        generation: Generation::try_new(1).unwrap(),
        source_binding: JournalDigest::parse(&"b".repeat(64)).unwrap(),
        profile_version: ProfileVersion::try_new(1).unwrap(),
        current_memory: MemoryBytes::try_new(512 * 1_048_576).unwrap(),
    };
    let data = ReservationObservation::try_new(fields).unwrap();
    assert!(
        std::str::from_utf8(&data.canonical_bytes())
            .unwrap()
            .contains(nil)
    );
    assert_eq!(data.journal_data().unwrap_err().code(), "UUID");
    assert!(worker_config::decode(&data.canonical_bytes()).is_ok());
}
