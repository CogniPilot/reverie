use super::*;
use serde_json::{Value as Json, json};
fn request() -> Json {
    json!({"purpose": POOL_INSTALLATION_REQUEST_PURPOSE,"version":1,
        "principal":{"accountId":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
            "personId":"owner","sessionEpoch":3},
        "policy":{"version":1,"purpose":crate::worker_pool::PURPOSE,
            "deployment":"installation-fixture","instanceRoot":"/home/example/reverie",
            "engineId":"11111111-2222-4333-8444-555555555555",
            "anchorImage":format!("sha256:{}","a".repeat(64)),
            "controllerImage":format!("sha256:{}","b".repeat(64)),
            "websiteContainer":"c".repeat(64),"brokerUid":1000,"brokerGid":100,
            "memoryMaxMiB":49152,"poolTasksMax":8192,"cpuWeight":100,
            "allowedCpus":[0,1,2,3,4,5,6,7],
            "employeeMemoryHighMiB":{"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee":1024}}})
}
fn decode(value: &Json) -> Result<PoolInstallationRequestData> {
    PoolInstallationRequestData::decode(&serde_json::to_vec(value).unwrap())
}
#[test]
fn nomination_and_exact_policy_share_one_canonical_binding_without_permission() {
    let value = request();
    let original = decode(&value).unwrap();
    let pretty =
        PoolInstallationRequestData::decode(&serde_json::to_vec_pretty(&value).unwrap()).unwrap();
    assert_eq!(original.digest(), pretty.digest());
    assert_eq!(original.principal().session_epoch(), 3);
    assert_eq!(original.policy().memory_max_mi_b, 49152);
    for (field, changed) in [
        (
            "principal",
            json!({"accountId":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
            "personId":"owner","sessionEpoch":4}),
        ),
        ("policy", {
            let mut p = value["policy"].clone();
            p["cpuWeight"] = json!(101);
            p
        }),
    ] {
        let mut next = value.clone();
        next[field] = changed;
        assert_ne!(decode(&next).unwrap().digest(), original.digest());
    }
}
#[test]
fn implicit_owner_unknown_grants_wrong_versions_and_foreign_policy_are_refused() {
    let original = request();
    for (field, changed) in [
        ("principal", Json::Null),
        ("version", json!(true)),
        ("version", json!(1.0)),
        ("version", json!(2)),
        ("purpose", json!(RAM_POOL_PURPOSE)),
        ("owner", json!(true)),
        ("granted", json!(true)),
        ("policy", json!({"memoryMaxMiB":49152})),
    ] {
        let mut next = original.clone();
        next[field] = changed;
        assert!(decode(&next).is_err(), "{field}");
    }
    let mut absent = original;
    absent.as_object_mut().unwrap().remove("principal");
    assert!(decode(&absent).is_err());
}
