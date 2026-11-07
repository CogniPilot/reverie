use reverie_core::{
    decimal::UnsignedInteger,
    gpu_access::{GpuBinding, GpuDeviceUuid, GpuExpected, GpuIntent, GpuRequestDocument},
    ids::ProfileSessionId,
    operations::{JournalDigest, JournalId},
    revision::{Generation, JS_SAFE_MAX},
};
fn id() -> JournalId {
    JournalId::parse("22222222-2222-4222-8222-222222222222").unwrap()
}
fn digest() -> JournalDigest {
    JournalDigest::parse(&"a".repeat(64)).unwrap()
}
fn binding() -> GpuBinding {
    GpuBinding::new(
        ProfileSessionId::parse(id().as_str()).unwrap(),
        Generation::try_new(1).unwrap(),
        digest(),
    )
}
#[test]
fn queue_cas_is_distinct_from_current_identity_and_preserves_stale_intent() {
    let expected = GpuExpected::try_new(id(), UnsignedInteger::from_u64(1), digest(), 0).unwrap();
    let intent = GpuIntent::new(expected, None);
    let row = intent.queued(&binding(), None).unwrap();
    assert_eq!(row.revision(), 1);
    assert!(row.matches_binding(&binding()));
    assert_eq!(
        intent
            .assert_current(&binding(), Some(&row))
            .unwrap_err()
            .code(),
        "GPU_STALE_REQUEST"
    );
    let document = GpuRequestDocument::empty().with_queued(id(), row).unwrap();
    assert_eq!(document.requests().len(), 1);
    let huge = UnsignedInteger::parse(&"9".repeat(200)).unwrap();
    let stale = GpuIntent::new(GpuExpected::try_new(id(), huge, digest(), 0).unwrap(), None);
    assert_eq!(
        stale.assert_current(&binding(), None).unwrap_err().code(),
        "GPU_STALE_REQUEST"
    );
    assert!(
        GpuExpected::try_new(id(), UnsignedInteger::from_u64(1), digest(), JS_SAFE_MAX).is_err()
    );
}
#[test]
fn physical_nil_uuid_is_valid_while_queue_hex_must_be_lowercase() {
    let value = GpuDeviceUuid::parse("GPU-00000000-0000-0000-0000-000000000000").unwrap();
    assert_eq!(
        value.device().as_str(),
        "nvidia.com/gpu=GPU-00000000-0000-0000-0000-000000000000"
    );
    assert!(GpuDeviceUuid::parse("GPU-AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA").is_err());
    assert!(GpuDeviceUuid::parse("gpu-00000000-0000-0000-0000-000000000000").is_err());
}
#[test]
fn actual_kernel_information_vectors_preserve_python_text_and_coordinates() {
    let data: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/gpu_access/physical.json")).unwrap();
    let device =
        reverie_core::device_policy::NvidiaCdiDevice::parse(data["device"].as_str().unwrap())
            .unwrap();
    let cases = data["cases"].as_array().unwrap();
    assert!(cases.len() > 40);
    for case in cases {
        let observed =
            reverie_core::gpu_access::PhysicalGpu::selected(case["raw"].as_str().unwrap(), &device);
        if case["result"].is_null() {
            assert!(!matches!(observed, Ok(Some(_))), "{}", case["name"]);
        } else {
            let value = observed.unwrap().unwrap();
            assert_eq!(
                value.uuid(),
                case["result"]["uuid"].as_str().unwrap(),
                "{}",
                case["name"]
            );
            assert_eq!(
                value.pci(),
                case["result"]["pci"].as_str().unwrap(),
                "{}",
                case["name"]
            );
            assert_eq!(
                value.minor(),
                case["result"]["deviceMinor"].as_str().unwrap(),
                "{}",
                case["name"]
            );
            assert_eq!(
                value.model(),
                case["result"]["model"].as_str().unwrap(),
                "{}",
                case["name"]
            );
        }
    }
}
