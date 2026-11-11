//! Real closed codec bounds, including the largest accepted policy and registry.
use super::*;
use reverie_core::ids::{ProfileEmployeeId, ProfileSessionId};

fn id(n: usize) -> String {
    format!("10000000-0000-4000-8000-{n:012}")
}
fn restore(n: usize) -> Vec<(ProfileEmployeeId, ProfileSessionId)> {
    (1..=n)
        .map(|n| {
            (
                ProfileEmployeeId::parse(&id(n)).unwrap(),
                ProfileSessionId::parse(&id(n + 1000)).unwrap(),
            )
        })
        .collect()
}
fn policy(n: usize) -> crate::worker_pool::WorkerPoolPolicy {
    let mut value = crate::worker_pool::tests::policy();
    value.employee_memory_high_mi_b = (1..=n).map(|n| (id(n), 49_152)).collect();
    value
}
fn maintenance() -> FleetMaintenanceRequest {
    let mut value = request();
    value["verb"] = json!("migrate-pool");
    decode(&value).unwrap()
}
fn completed(prepared: PreparedFleetMigrationReply) -> FleetReplyFrame {
    let config = crate::worker_config::decode(br#"{}"#).unwrap();
    prepared.finish(
        &crate::worker_config::config_digest(&config),
        &crate::reservation_control::domain_digest(&config).unwrap(),
    )
}
#[test]
fn cohort_46_50_and_registry_max_encode_before_effects_and_fill_only_receipt_digests() {
    for n in [46, 50, crate::storage_identity::MAX_PROVIDER_EMPLOYEES] {
        let frame = completed(
            maintenance()
                .prepare_migration_result(&policy(n), &restore(n))
                .unwrap(),
        );
        assert!(frame.bytes().len() > crate::human_protocol::MAX_FRAME);
        assert!(frame.bytes().len() <= FLEET_REPLY_MAX_FRAME);
        assert!(
            HumanFrame::decode(frame.bytes()).is_err(),
            "ordinary budget must stay narrow"
        );
        let wire: Json = serde_json::from_slice(frame.bytes()).unwrap();
        assert_eq!(wire["restore"].as_array().unwrap().len(), n);
        assert_eq!(wire["policy"], serde_json::to_value(policy(n)).unwrap());
        let config = crate::worker_config::decode(br#"{}"#).unwrap();
        assert_eq!(
            wire["domainDigest"],
            crate::reservation_control::domain_digest(&config)
                .unwrap()
                .to_hex()
        );
        assert_ne!(wire["configurationDigest"], "0".repeat(64));
        assert_eq!(wire["approval"], request()["approval"]);
    }
}
#[test]
fn maximal_escaped_policy_and_registry_fit_the_declared_fleet_budget() {
    let mut value = policy(256);
    value.instance_root = format!("/{}{}", "\u{1}".repeat(4087), "/reverie");
    assert_eq!(value.instance_root.len(), 4096);
    value.deployment = "a".repeat(40);
    value.broker_uid = u32::MAX;
    value.broker_gid = u32::MAX;
    value.cpu_weight = 10_000;
    value.allowed_cpus = (0..4096).collect();
    value.validate().unwrap();
    let original = maintenance();
    let frame = completed(
        original
            .prepare_migration_result(&value, &restore(64))
            .unwrap(),
    );
    eprintln!(
        "maximal fleet result bytes: {} / {}",
        frame.bytes().len(),
        FLEET_REPLY_MAX_FRAME
    );
    assert!(frame.bytes().len() <= FLEET_REPLY_MAX_FRAME);
    let wire: Json = serde_json::from_slice(frame.bytes()).unwrap();
    assert_eq!(wire["policy"], serde_json::to_value(&value).unwrap());
    let preview = preview::selected(&preview::request_value())
        .unwrap()
        .qualified_reply(
            original.selection(),
            &value,
            reverie_core::revision::JS_SAFE_MAX,
        )
        .unwrap();
    assert!(preview.bytes().len() <= FLEET_REPLY_MAX_FRAME);
}
#[test]
fn unsupported_or_ambiguous_cohort_refuses_at_preparation() {
    let request = maintenance();
    assert_eq!(
        request
            .prepare_migration_result(&policy(65), &restore(65))
            .err()
            .unwrap()
            .code(),
        "POOL_MIGRATION_RESTORE_BOUND"
    );
    let mut duplicate = restore(2);
    duplicate[1] = duplicate[0].clone();
    assert_eq!(
        request
            .prepare_migration_result(&policy(2), &duplicate)
            .err()
            .unwrap()
            .code(),
        "POOL_MIGRATION_RESTORE_AMBIGUOUS"
    );
    let mut invalid = policy(1);
    invalid.instance_root.push_str(&"x".repeat(4096));
    assert!(
        request
            .prepare_migration_result(&invalid, &restore(1))
            .is_err()
    );
}
