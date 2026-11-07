use super::*;
use std::{os::unix::fs::MetadataExt, path::Path};
pub(super) fn end() -> Instant {
    Instant::now() + Duration::from_secs(20)
}
pub(super) struct Context {
    pub(super) fixture: Fixture,
    pub(super) service: Arc<WorkerReportService>,
    pub(super) connection: WorkerLaunchConnection,
    hold: WorkerLaunchHold,
    _client: UnixStream,
    pub(super) workflow: LaptopWorkflow,
    pub(super) started: StartedContainer,
    pub(super) effective: EffectiveWorkerConfig,
}
impl Context {
    pub(super) fn new() -> Self {
        Self::configured(true)
    }
    pub(super) fn without_memory_policy() -> Self {
        Self::configured(false)
    }
    fn configured(enabled: bool) -> Self {
        let mut fixture = Fixture::employee("created-memory");
        let mut raw: serde_json::Value =
            serde_json::from_slice(&worker_config::encode_config(&fixture.source)).unwrap();
        raw["memoryMiB"] = json!(2048);
        if enabled {
            raw["employeeMemoryPolicies"] =
                json!({"11111111-2222-4333-8444-555555555555":{"swapMiB":0,"memoryHighMiB":1024}});
        }
        fixture.source = worker_config::decode(&serde_json::to_vec(&raw).unwrap()).unwrap();
        let sid =
            reverie_core::ids::ProfileSessionId::parse("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee")
                .unwrap();
        let identity = crate::worker_identity::storage_identity(
            &ResourceIdentitySettings::capture_worker_config(&fixture.source).unwrap(),
        )
        .unwrap();
        let effective = crate::device_policy::project_effective_memory_resources(
            &fixture.source,
            &identity,
            &sid,
            fixture.source.clone(),
        )
        .unwrap()
        .into_configuration();
        let service = Arc::new(WorkerReportService::from_runtime(fixture.runtime()));
        let (client, connection, hold) = fixture.accepted(&service, "opencode");
        let (nix, plan, _request, phone) =
            fixture.resources_with_effective(&sid, effective.clone());
        let runtime = fixture.runtime();
        let workflow = runtime
            .retain_laptop_network_for_connection(&nix, plan, phone, &connection)
            .unwrap_or_else(|e| panic!("{}", e.cause()));
        assert_eq!(
            runtime
                .run_laptop_network_for_connection(&workflow, &connection)
                .unwrap(),
            LaptopNetworkProgress::Ready
        );
        let telemetry = CommandTelemetry::capture(runtime, &fixture.source).unwrap();
        let LaptopCreation::Created(created) = runtime
            .create_laptop_for_connection(&workflow, &telemetry, &connection)
            .unwrap()
        else {
            panic!("actual create");
        };
        runtime.publish_laptop_launch(&created).unwrap();
        let ContainerStart::Started(started) = runtime
            .start_laptop_container_for_connection(&created, &connection)
            .unwrap()
        else {
            panic!("actual start");
        };
        let digest = worker_config::policy_digest(&effective).to_hex();
        let row = json!([{"Id":"c".repeat(64),"Name":format!("/fixture-agent-{}",sid.as_str()),"Config":{"Labels":{"reverie.worker":"fixture","reverie.session":sid.as_str(),"reverie.worker-policy":digest}},"State":{"Running":true,"Pid":321},"HostConfig":{"Memory":2147483648u64,"MemorySwap":2147483648u64,"PidsLimit":128,"NanoCpus":0},"Image":format!("sha256:{}","a".repeat(64))}]);
        fs::write(
            fixture.root.join("memory-inspect.json"),
            serde_json::to_vec(&row).unwrap(),
        )
        .unwrap();
        Self {
            fixture,
            service,
            connection,
            hold,
            _client: client,
            workflow,
            started,
            effective,
        }
    }
    pub(super) fn finish(mut self) {
        // Explicit isolated synthetic teardown AFTER retention assertions;
        // no production lease/stop/global/handler finalization is inferred.
        assert!(
            self.fixture
                .runtime()
                .reclaim_laptop_network(self.workflow.clone())
                .is_err()
        );
        self.connection.close_socket(end()).unwrap();
        self.hold.release(end()).unwrap();
        self.service.close(end()).unwrap();
    }
}
pub(super) struct Facts {
    kernel: crate::worker_laptop::memory::tests::KernelFixture,
    pub(super) targets: Cell<usize>,
    pub(super) hosts: Cell<usize>,
}
impl Facts {
    pub(super) fn new() -> Self {
        Self {
            kernel: crate::worker_laptop::memory::tests::KernelFixture::new(),
            targets: Cell::new(0),
            hosts: Cell::new(0),
        }
    }
    pub(super) fn root(&self) -> &Path {
        &self.kernel.root
    }
    pub(super) fn held(&self) -> usize {
        let target = fs::metadata(self.root().join("cgroup/laptop")).unwrap();
        fs::read_dir("/proc/self/fd")
            .unwrap()
            .filter_map(|entry| fs::metadata(entry.unwrap().path()).ok())
            .filter(|entry| (entry.dev(), entry.ino()) == (target.dev(), target.ino()))
            .count()
    }
}
impl Observations for Facts {
    fn host_root(&self, _: Instant) -> Result<()> {
        self.hosts.set(self.hosts.get() + 1);
        Ok(())
    }
    fn target(&self, pid: u32) -> Result<target::Target> {
        assert_eq!(pid, 321);
        self.targets.set(self.targets.get() + 1);
        Ok(self.kernel.target())
    }
    fn limits(
        &self,
        _: &RecoveryInspection,
        policy: &ObservedMemoryPolicy,
        _: Instant,
    ) -> Result<()> {
        let target = self.kernel.target();
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
