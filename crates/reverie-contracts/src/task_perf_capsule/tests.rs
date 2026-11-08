use super::*;
use serde_json::{Value, json};

fn fixture() -> Value {
    let artifact = |output| {
        json!({
            "input":"/nix/store/fixture/bin/source", "input_sha256":"a".repeat(64),
            "output":output, "sha256":"b".repeat(64),
        })
    };
    json!({
        "schema":"reverie-perf-guest-capsule-build-v2",
        "purpose":"unselected-image-data-no-grant-or-attestation",
        "prefix":PREFIX,"absentFallback":"/opt/rvprf/",
        "absentSystemPreload":"/opt/rvprf/preload.off",
        "closureInputSha256":"c".repeat(64),
        "artifacts":[artifact("bin/perf"),artifact("bin/reverie-perf-check"),
            artifact("lib/ld-linux-x86-64.so.2"),artifact("bin/reverie-worker-init"),artifact("notices/upstream/LICENSE")],
    })
}
fn decode(value: &Value) -> Result<PerfCapsuleInventory> {
    PerfCapsuleInventory::decode(&serde_json::to_vec(value).unwrap())
}
#[test]
fn inventory_selects_exact_code_without_turning_notices_into_executable_inputs() {
    let inventory = decode(&fixture()).unwrap();
    assert_eq!(inventory.code_files().len(), 4);
    assert!(
        inventory
            .code_files()
            .contains_key("bin/reverie-perf-check")
    );
    assert!(
        !inventory
            .code_files()
            .contains_key("notices/upstream/LICENSE")
    );
}
#[test]
fn inventory_refuses_ambiguous_missing_or_escaping_executable_inputs() {
    for (pointer, replacement) in [
        ("/schema", json!("reverie-perf-guest-capsule-build-v1")),
        ("/prefix", json!("/nix/store/mutable")),
        ("/artifacts/0/output", json!("../bin/perf")),
        ("/artifacts/0/output", json!("/bin/perf")),
        ("/artifacts/0/output", json!("lib/../../perf")),
        ("/artifacts/0/output", json!("bin/arbitrary-command")),
        ("/artifacts/0/sha256", json!("B".repeat(64))),
        ("/artifacts/0/input", json!("/tmp/perf")),
        ("/artifacts/1/output", json!("bin/perf")),
    ] {
        let mut value = fixture();
        *value.pointer_mut(pointer).unwrap() = replacement;
        assert!(decode(&value).is_err(), "{pointer}");
    }
    let mut value = fixture();
    value["artifacts"].as_array_mut().unwrap().remove(2);
    assert!(decode(&value).is_err());
    let mut missing_init = fixture();
    missing_init["artifacts"].as_array_mut().unwrap().remove(3);
    assert!(decode(&missing_init).is_err());
    let raw = serde_json::to_string(&fixture()).unwrap();
    let duplicate = raw.replacen("\"schema\":", "\"schema\":\"duplicate\",\"schema\":", 1);
    assert!(PerfCapsuleInventory::decode(duplicate.as_bytes()).is_err());
}
