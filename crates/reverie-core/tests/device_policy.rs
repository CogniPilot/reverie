use reverie_core::device_policy::*;
use reverie_core::ids::{ProfileEmployeeId, ProfileSessionId};
use reverie_core::resources::{BudgetMode, CpuQuota, ResourcePolicy};
use std::collections::BTreeMap;

fn sid(index: u32) -> ProfileSessionId {
    ProfileSessionId::parse(&format!("{index:08x}-0000-0000-0000-000000000000")).unwrap()
}
fn eid(index: u32) -> ProfileEmployeeId {
    ProfileEmployeeId::parse(sid(index).as_str()).unwrap()
}
fn device() -> NvidiaCdiDevice {
    NvidiaCdiDevice::parse("nvidia.com/gpu=GPU-aBCDef12-3456-7890-ABcd-0123456789EF").unwrap()
}
fn ram(memory: u32) -> ResourcePolicy {
    ResourcePolicy::try_new(
        BudgetMode::Pool,
        memory,
        128,
        CpuQuota::from_integer(0).unwrap(),
        8192,
        1024,
    )
    .unwrap()
}

#[test]
fn physical_cdi_tokens_preserve_hex_case_and_refuse_broad_or_injected_selectors() {
    assert_eq!(
        device().as_str(),
        "nvidia.com/gpu=GPU-aBCDef12-3456-7890-ABcd-0123456789EF"
    );
    assert!(
        NvidiaCdiDevice::parse("nvidia.com/gpu=GPU-00000000-0000-0000-0000-000000000000").is_ok()
    );
    for value in [
        "nvidia.com/gpu=all",
        "nvidia.com/gpu=0",
        "/dev/nvidia0",
        "nvidia.com/gpu=MIG-00000000-0000-0000-0000-000000000000",
        "nvidia.com/gpu=gpu-00000000-0000-0000-0000-000000000000",
        "nvidia.com/gpu=GPU-00000000-0000-0000-0000-00000000000z",
        "nvidia.com/gpu=GPU-00000000-0000-0000-0000-000000000000 --privileged",
    ] {
        assert!(NvidiaCdiDevice::parse(value).is_err(), "{value}");
    }
}
#[test]
fn gpu_absence_empty_legacy_priority_and_combined_owner_count_are_preserved() {
    let employees = BTreeMap::from([(eid(1), device())]);
    let absent = GpuPolicies::try_new(None, employees.clone()).unwrap();
    assert_eq!(absent.project(&sid(2), None), None);
    let empty = GpuPolicies::try_new(Some(BTreeMap::new()), employees.clone()).unwrap();
    assert_eq!(empty.project(&sid(2), None), Some(BTreeMap::new()));
    assert_eq!(
        absent.project(&sid(2), Some(&eid(1))).unwrap()[&sid(2)],
        device()
    );
    let legacy_device =
        NvidiaCdiDevice::parse("nvidia.com/gpu=GPU-11111111-1111-1111-1111-111111111111").unwrap();
    let legacy = GpuPolicies::try_new(
        Some(BTreeMap::from([(sid(2), legacy_device.clone())])),
        employees.clone(),
    )
    .unwrap();
    assert!(!legacy.needs_current_employee(&sid(2)));
    assert_eq!(
        legacy.project(&sid(2), Some(&eid(1))).unwrap()[&sid(2)],
        legacy_device
    );
    assert_eq!(
        legacy.create_args(&sid(2), None),
        vec![
            "--device",
            legacy_device.as_str(),
            "--env",
            "LD_LIBRARY_PATH=/usr/local/nvidia/lib64:/usr/local/nvidia/lib"
        ]
    );
    let entries = (0..31).map(|index| (sid(index), device())).collect();
    assert!(GpuPolicies::try_new(Some(entries), employees.clone()).is_ok());
    let entries = (0..32).map(|index| (sid(index), device())).collect();
    assert_eq!(
        GpuPolicies::try_new(Some(entries), employees).unwrap_err(),
        DevicePolicyError::GpuCount
    );
}
#[test]
fn soft_memory_shape_bounds_and_pool_commitments_are_checked_once() {
    for high in [511, 1_048_577] {
        assert!(SoftMemoryPolicy::try_new(Some(high), 0).is_err());
    }
    for high in [512, 1_048_576] {
        assert!(SoftMemoryPolicy::try_new(Some(high), 0).is_ok());
    }
    assert!(SoftMemoryPolicy::try_new(None, 1_048_577).is_err());
    assert!(MemoryPolicies::try_new(BTreeMap::new(), 1_048_577).is_err());
    let policy = SoftMemoryPolicy::try_new(None, 1024).unwrap();
    assert!(MemoryPolicies::try_new(BTreeMap::from([(eid(1), policy.clone())]), 1023).is_err());
    assert!(
        MemoryPolicies::try_new(
            (0..256).map(|index| (eid(index), policy.clone())).collect(),
            1024
        )
        .is_ok()
    );
    assert_eq!(
        MemoryPolicies::try_new(
            (0..257).map(|index| (eid(index), policy.clone())).collect(),
            1024
        )
        .unwrap_err(),
        DevicePolicyError::MemoryCount
    );
}
#[test]
fn only_selected_high_threshold_reads_the_checked_effective_ram_ceiling() {
    let policies = MemoryPolicies::try_new(
        BTreeMap::from([
            (eid(1), SoftMemoryPolicy::try_new(Some(1024), 2048).unwrap()),
            (eid(2), SoftMemoryPolicy::try_new(None, 0).unwrap()),
        ]),
        4096,
    )
    .unwrap();
    assert_eq!(policies.project(None, None).unwrap(), None);
    assert_eq!(policies.project(Some(&eid(3)), None).unwrap(), None);
    assert!(policies.project(Some(&eid(2)), None).unwrap().is_some());
    assert_eq!(
        policies.project(Some(&eid(1)), None).unwrap_err(),
        DevicePolicyError::EffectiveCeiling
    );
    for memory in [0, 512, 1024] {
        assert_eq!(
            policies
                .project(Some(&eid(1)), Some(&ram(memory)))
                .unwrap_err(),
            DevicePolicyError::MemoryHigh
        );
    }
    let projection = policies
        .project(Some(&eid(1)), Some(&ram(2048)))
        .unwrap()
        .unwrap();
    assert_eq!(projection.policy().memory_high_mib(), Some(1024));
    assert_eq!(projection.swap_pool_mib(), 4096);
    assert_eq!(projection.swap_bytes(), 2_147_483_648);
}
