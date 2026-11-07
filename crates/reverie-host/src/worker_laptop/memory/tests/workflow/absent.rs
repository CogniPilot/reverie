//! Actual same-record local refusals; no native memory observation is permitted.
use super::*;
enum Fence {
    SuppliedDeadline,
    Cancellation,
    StopDeadline,
}
struct NoNativeMemory;
impl Observations for NoNativeMemory {
    fn host_root(&self, _: Instant) -> Result<()> {
        panic!("absent policy must not observe the host")
    }
    fn target(&self, _: u32) -> Result<super::super::super::target::Target> {
        panic!("absent policy must not capture a memory target")
    }
    fn limits(&self, _: &RecoveryInspection, _: &ObservedMemoryPolicy, _: Instant) -> Result<()> {
        panic!("absent policy must not read physical memory limits")
    }
}
fn refuses_once(name: &str, fence: Fence) {
    if crate::test_process::isolate_case(&format!(
        "worker_laptop::memory::tests::workflow::absent::{name}"
    )) {
        return;
    }
    let fixture = Fixture::new("created-memory");
    let (workflow, started) = actual_started(&fixture, None);
    let trace = fs::read(fixture.root.join("trace")).unwrap();
    let (deadline, expected) = match fence {
        Fence::SuppliedDeadline => (
            Instant::now() - Duration::from_secs(1),
            "LAPTOP_MEMORY_DEADLINE",
        ),
        Fence::Cancellation => {
            assert!(fixture.runtime().stop_deadline().is_none());
            fixture.runtime().cancellation().cancel();
            (end(), "WORKER_LAPTOP_STOPPED")
        }
        Fence::StopDeadline => {
            fixture
                .runtime()
                .installed_engine()
                .expire_stop_for_owned_test();
            assert!(fixture.runtime().stop_deadline().unwrap() < Instant::now());
            (end(), "LAPTOP_MEMORY_DEADLINE")
        }
    };
    let result = fixture
        .runtime()
        .laptop_workflows()
        .configure_memory(fixture.runtime(), &started, deadline, &NoNativeMemory)
        .unwrap();
    assert!(matches!(result, MemoryConfiguration::Rejected));
    let error = workflow.failure().unwrap().unwrap();
    assert!(matches!(error.as_ref(), LaptopError::Refused(code) if *code == expected));
    {
        let record = workflow.record.try_lock().unwrap();
        assert!(record.phase == Phase::Known);
        assert!(record.creation.as_ref().unwrap().stage == create::CreateStage::ConfiguringMemory);
        assert!(record.pending.is_none() && !record.unknown);
    }
    // Pre-effect refusal consumes this phase, keeps the original created owners
    // and permits no replay with a renewed caller deadline.
    assert!(matches!(
        fixture.runtime().laptop_workflows().configure_memory(
            fixture.runtime(),
            &started,
            end(),
            &NoNativeMemory,
        ),
        Err(LaptopError::Refused("WORKER_LAPTOP_MEMORY_PHASE"))
    ));
    assert_eq!(fs::read(fixture.root.join("trace")).unwrap(), trace);
    assert!(fixture.runtime().reclaim_laptop_network(workflow).is_err());
    assert!(
        crate::worker_nix::NixStoreGuard::acquire_migration(
            &fixture.source,
            &ProfileSessionId::parse(SID).unwrap(),
        )
        .is_err()
    );
    if matches!(fence, Fence::StopDeadline) {
        // An expired original stop budget cannot acknowledge global cleanup.
        // This case runs in its own process and keeps those owners until exit.
        fixture.retain_after_expired_stop();
    }
}
#[test]
fn absent_policy_expired_supplied_deadline_refuses_without_native_dispatch() {
    refuses_once(
        "absent_policy_expired_supplied_deadline_refuses_without_native_dispatch",
        Fence::SuppliedDeadline,
    );
}
#[test]
fn absent_policy_cancellation_refuses_without_native_dispatch() {
    refuses_once(
        "absent_policy_cancellation_refuses_without_native_dispatch",
        Fence::Cancellation,
    );
}
#[test]
fn absent_policy_expired_stop_deadline_refuses_without_native_dispatch() {
    refuses_once(
        "absent_policy_expired_stop_deadline_refuses_without_native_dispatch",
        Fence::StopDeadline,
    );
}
