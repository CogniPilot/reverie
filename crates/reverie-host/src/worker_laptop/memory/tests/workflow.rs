use super::*;
use crate::{command_telemetry::CommandTelemetry, worker_laptop::tests::Fixture};
use reverie_contracts::worker_config::{self, EffectiveWorkerConfig};
use reverie_core::ids::ProfileSessionId;
use serde_json::json;
use std::cell::Cell;
mod absent;
mod cold;
const SID: &str = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

struct ObservedKernel {
    fixture: KernelFixture,
    calls: Cell<usize>,
    fail_limits: bool,
}
impl Observations for ObservedKernel {
    fn host_root(&self, _: Instant) -> Result<()> {
        self.calls.set(self.calls.get() + 1);
        Ok(())
    }
    fn target(&self, pid: u32) -> Result<super::super::target::Target> {
        assert_eq!(pid, 321);
        self.calls.set(self.calls.get() + 1);
        Ok(self.fixture.target())
    }
    fn limits(
        &self,
        _: &RecoveryInspection,
        policy: &ObservedMemoryPolicy,
        _: Instant,
    ) -> Result<()> {
        self.calls.set(self.calls.get() + 1);
        if self.fail_limits {
            return Err(LaptopError::MemoryKernel(
                crate::reservation_kernel::ReservationKernelError::Refused(
                    "OWNED_READBACK_FAILURE",
                ),
            ));
        }
        let target = self.fixture.target();
        let result = target.hard_is(policy.memory().as_str()).and_then(|()| {
            target.high_is(
                policy
                    .high()
                    .map_or("max", reverie_core::decimal::UnsignedInteger::as_str),
            )
        });
        finalized(result, target.close())
    }
}
fn actual_started(
    fixture: &Fixture,
    policy: Option<serde_json::Value>,
) -> (LaptopWorkflow, StartedContainer) {
    let mut effective: serde_json::Value =
        serde_json::from_slice(&worker_config::encode_config(&fixture.source)).unwrap();
    if let Some(policy) = policy {
        effective["memoryMiB"] = json!(2048);
        effective["laptopMemoryPolicy"] = policy;
    }
    let effective: EffectiveWorkerConfig =
        worker_config::decode(&serde_json::to_vec(&effective).unwrap()).unwrap();
    let digest = worker_config::policy_digest(&effective).to_hex();
    let (nix, plan, request, phone) =
        fixture.resources_with_effective(&ProfileSessionId::parse(SID).unwrap(), effective);
    let workflow = fixture
        .runtime()
        .retain_laptop_network(&nix, plan, request, phone)
        .unwrap_or_else(|_| panic!("actual retain"));
    fixture
        .runtime()
        .run_laptop_network(&workflow, end())
        .unwrap();
    let telemetry = CommandTelemetry::capture(fixture.runtime(), &fixture.source).unwrap();
    let LaptopCreation::Created(created) = fixture
        .runtime()
        .create_laptop(&workflow, &telemetry, end())
        .unwrap()
    else {
        panic!("actual create");
    };
    fixture.runtime().publish_laptop_launch(&created).unwrap();
    let ContainerStart::Started(started) = fixture
        .runtime()
        .start_laptop_container(&created, end())
        .unwrap()
    else {
        panic!("actual start");
    };
    let row = json!([{"Id":"c".repeat(64),"Name":format!("/fixture-agent-{SID}"),"Config":{"Labels":{"reverie.worker":"fixture","reverie.session":SID,"reverie.worker-policy":digest}},"State":{"Running":true,"Pid":321},"Mounts":[]}]);
    fs::write(
        fixture.root.join("memory-inspect.json"),
        serde_json::to_vec(&row).unwrap(),
    )
    .unwrap();
    (workflow, started)
}

#[test]
fn selected_existing_helper_still_requires_independent_physical_readback() {
    if crate::test_process::isolate_case(
        "worker_laptop::memory::tests::workflow::selected_existing_helper_still_requires_independent_physical_readback",
    ) {
        return;
    }
    use std::{
        io::{Read, Write},
        os::unix::net::UnixListener,
    };
    for helper_writes in [true, false] {
        let mut fixture = Fixture::new("created-memory");
        let kernel = ObservedKernel {
            fixture: KernelFixture::new(),
            calls: Cell::new(0),
            fail_limits: false,
        };
        let path = kernel.fixture.root.join("helper.sock");
        let mut source: serde_json::Value =
            serde_json::from_slice(&worker_config::encode_config(&fixture.source)).unwrap();
        source["softLimitHelperSocket"] = json!(path);
        fixture.source = worker_config::decode(&serde_json::to_vec(&source).unwrap()).unwrap();
        let (workflow, started) =
            actual_started(&fixture, Some(json!({"swapMiB":0,"memoryHighMiB":1024})));
        let listener = UnixListener::bind(&path).unwrap();
        let leaf = kernel.fixture.root.join("cgroup/laptop/memory.high");
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut payload = Vec::new();
            while payload.last() != Some(&b'\n') {
                let mut byte = [0];
                assert_eq!(socket.read(&mut byte).unwrap(), 1);
                payload.push(byte[0]);
            }
            let value: serde_json::Value = serde_json::from_slice(&payload).unwrap();
            assert_eq!(
                value,
                json!({"v":1,"sessionId":SID,"containerId":"c".repeat(64)})
            );
            if helper_writes {
                fs::write(leaf, "1073741824\n").unwrap();
            }
            socket
                .write_all(b"{\"ok\":true,\"memoryHighBytes\":1073741824}\n")
                .unwrap();
        });
        let result = fixture
            .runtime()
            .laptop_workflows()
            .configure_memory(fixture.runtime(), &started, end(), &kernel)
            .unwrap();
        server.join().unwrap();
        if helper_writes {
            let MemoryConfiguration::Configured(owner) = result else {
                panic!("helper with physical readback");
            };
            assert!(owner.same_workflow(&workflow));
        } else {
            assert!(matches!(result, MemoryConfiguration::Retained));
            assert!(matches!(
                workflow.failure().unwrap().as_deref(),
                Some(LaptopError::MemoryEffectUnconfirmed(_))
            ));
        }
        assert_eq!(kernel.calls.get(), 3);
        assert!(fixture.runtime().reclaim_laptop_network(workflow).is_err());
    }
}
#[test]
fn actual_started_absent_swap_and_direct_high_paths_are_one_shot_and_same_record() {
    if crate::test_process::isolate_case(
        "worker_laptop::memory::tests::workflow::actual_started_absent_swap_and_direct_high_paths_are_one_shot_and_same_record",
    ) {
        return;
    }
    for policy in [
        None,
        Some(json!({"swapMiB":0})),
        Some(json!({"swapMiB":0,"memoryHighMiB":1024})),
    ] {
        let absent = policy.is_none();
        let high = policy
            .as_ref()
            .is_some_and(|p| p.get("memoryHighMiB").is_some());
        let fixture = Fixture::new("created-memory");
        let (workflow, started) = actual_started(&fixture, policy);
        let kernel = ObservedKernel {
            fixture: KernelFixture::new(),
            calls: Cell::new(0),
            fail_limits: false,
        };
        let MemoryConfiguration::Configured(ready) = fixture
            .runtime()
            .laptop_workflows()
            .configure_memory(fixture.runtime(), &started, end(), &kernel)
            .unwrap()
        else {
            panic!("memory configured");
        };
        assert!(ready.same_workflow(&workflow));
        assert_eq!(kernel.calls.get(), if absent { 0 } else { 3 });
        assert_eq!(
            fs::read_to_string(kernel.fixture.root.join("cgroup/laptop/memory.high")).unwrap(),
            if high { "1073741824\n" } else { "max\n" }
        );
        assert!(
            fixture
                .runtime()
                .configure_started_laptop_memory(&started, end())
                .is_err()
        );
        let other = Fixture::new("created-memory");
        assert!(
            other
                .runtime()
                .configure_started_laptop_memory(&started, end())
                .is_err()
        );
        assert!(fixture.runtime().reclaim_laptop_network(workflow).is_err());
    }
}
#[test]
fn independent_readback_failure_after_a_real_write_retains_every_original_owner() {
    if crate::test_process::isolate_case(
        "worker_laptop::memory::tests::workflow::independent_readback_failure_after_a_real_write_retains_every_original_owner",
    ) {
        return;
    }
    let fixture = Fixture::new("created-memory");
    let (workflow, started) =
        actual_started(&fixture, Some(json!({"swapMiB":0,"memoryHighMiB":1024})));
    let kernel = ObservedKernel {
        fixture: KernelFixture::new(),
        calls: Cell::new(0),
        fail_limits: true,
    };
    assert!(matches!(
        fixture
            .runtime()
            .laptop_workflows()
            .configure_memory(fixture.runtime(), &started, end(), &kernel)
            .unwrap(),
        MemoryConfiguration::Retained
    ));
    assert!(matches!(
        workflow.failure().unwrap().as_deref(),
        Some(LaptopError::MemoryEffectUnconfirmed(_))
    ));
    assert_eq!(
        fs::read_to_string(kernel.fixture.root.join("cgroup/laptop/memory.high")).unwrap(),
        "1073741824\n"
    );
    assert!(fixture.runtime().reclaim_laptop_network(workflow).is_err());
    assert!(fixture.runtime().close(end()).is_err());
}
#[test]
fn strict_identity_failure_refuses_before_target_capture_or_any_write() {
    if crate::test_process::isolate_case(
        "worker_laptop::memory::tests::workflow::strict_identity_failure_refuses_before_target_capture_or_any_write",
    ) {
        return;
    }
    let fixture = Fixture::new("created-memory");
    let (workflow, started) =
        actual_started(&fixture, Some(json!({"swapMiB":0,"memoryHighMiB":1024})));
    let path = fixture.root.join("memory-inspect.json");
    let mut value: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    value[0]["Id"] = json!("f".repeat(64));
    fs::write(path, serde_json::to_vec(&value).unwrap()).unwrap();
    let kernel = ObservedKernel {
        fixture: KernelFixture::new(),
        calls: Cell::new(0),
        fail_limits: false,
    };
    assert!(matches!(
        fixture
            .runtime()
            .laptop_workflows()
            .configure_memory(fixture.runtime(), &started, end(), &kernel)
            .unwrap(),
        MemoryConfiguration::Rejected
    ));
    assert_eq!(kernel.calls.get(), 1);
    assert!(matches!(
        workflow.failure().unwrap().as_deref(),
        Some(LaptopError::MemoryIdentity(_))
    ));
    assert_eq!(
        fs::read_to_string(kernel.fixture.root.join("cgroup/laptop/memory.high")).unwrap(),
        "max\n"
    );
}

#[test]
fn unsupported_host_root_refuses_before_engine_inspection_or_target_capture() {
    if crate::test_process::isolate_case(
        "worker_laptop::memory::tests::workflow::unsupported_host_root_refuses_before_engine_inspection_or_target_capture",
    ) {
        return;
    }
    struct Unsupported;
    impl Observations for Unsupported {
        fn host_root(&self, _: Instant) -> Result<()> {
            Err(LaptopError::MemoryKernel(
                crate::reservation_kernel::ReservationKernelError::Refused(
                    "RESERVATION_HOST_HIERARCHY_REQUIRED",
                ),
            ))
        }
        fn target(&self, _: u32) -> Result<super::super::target::Target> {
            panic!("no target on unsupported host")
        }
        fn limits(
            &self,
            _: &RecoveryInspection,
            _: &ObservedMemoryPolicy,
            _: Instant,
        ) -> Result<()> {
            panic!("no readback on unsupported host")
        }
    }
    let fixture = Fixture::new("created-memory");
    let (workflow, started) = actual_started(&fixture, Some(json!({"swapMiB":0})));
    assert!(matches!(
        fixture
            .runtime()
            .laptop_workflows()
            .configure_memory(fixture.runtime(), &started, end(), &Unsupported)
            .unwrap(),
        MemoryConfiguration::Rejected
    ));
    let trace = fs::read_to_string(fixture.root.join("trace")).unwrap();
    assert!(!trace.lines().any(|line| line.starts_with("inspect\0")));
    assert!(matches!(
        workflow.failure().unwrap().as_deref(),
        Some(LaptopError::MemoryKernel(_))
    ));
}
