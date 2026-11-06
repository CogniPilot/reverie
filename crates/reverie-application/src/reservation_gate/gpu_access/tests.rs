use super::*;
use crate::{reservation_gate::tests::Tree, reservation_observer::tests::Fixture};
use reverie_core::{
    decimal::UnsignedInteger,
    gpu_access::{GpuChoice, PhysicalGpu},
    revision::Generation,
};
use reverie_host::gpu_access::{CdiObservation, GpuHardware, GpuHostError};
use serde_json::{Value, json};
use std::{cell::Cell, fs, os::unix::fs::PermissionsExt};
pub(super) mod faults;
const EID: &str = "11111111-2222-4333-8444-555555555555";
const SID: &str = "22222222-2222-4333-8444-555555555555";
const DEVICE: &str = "GPU-11111111-2222-3333-4444-555555555555";
struct Setup {
    tree: Tree,
    fixture: Arc<Fixture>,
    gate: ReservationGate,
}
impl Setup {
    fn new(enabled: bool) -> Self {
        Self::with_worker(enabled, None)
    }
    fn with_worker(enabled: bool, running: Option<bool>) -> Self {
        let mut tree = Tree::new();
        let mut config: Value = serde_json::from_slice(&tree.raw).unwrap();
        config["employeeGpuGrants"] = if enabled {
            json!({EID:format!("nvidia.com/gpu={DEVICE}")})
        } else {
            json!({})
        };
        tree.raw = serde_json::to_vec(&config).unwrap();
        tree.write("worker.json", &tree.raw);
        tree.marker(&config);
        tree.write("company.json",&serde_json::to_vec(&json!({"employees":[{"id":EID,"sessionId":SID,"sessionGeneration":1,"owner":null}],"retired":[]})).unwrap());
        fs::create_dir(tree.root.join("cdi")).unwrap();
        tree.write("cdi/device.json",&serde_json::to_vec(&json!({"kind":"nvidia.com/gpu","devices":[{"name":DEVICE,"containerEdits":{"deviceNodes":[{"path":"/dev/nvidia0"}]}}]})).unwrap());
        let fixture = Fixture::new();
        let site = json!({"Id":format!("{:064x}",1),"Name":"/test-console","Image":format!("sha256:{}","a".repeat(64)),"Config":{"Labels":{}},"State":{"Running":true,"Pid":123},"Mounts":[],"HostConfig":{"Memory":536870912,"MemorySwap":536870912,"PidsLimit":128,"NanoCpus":0}});
        let mut rows = vec![site.clone()];
        if let Some(running) = running {
            let mut worker = site;
            worker["Id"] = json!(format!("{:064x}", 2));
            worker["Name"] = json!(format!("/test-agent-{SID}"));
            worker["State"] = json!({"Running":running,"Pid":if running{124}else{0}});
            worker["Config"]["Labels"] =
                json!({"reverie.worker":"test","reverie.session":SID,"reverie.employee":EID});
            rows.push(worker);
        }
        for _ in 0..256 {
            fixture.inventory(&rows);
        }
        let gate = tree.gate(&fixture, true);
        Self {
            tree,
            fixture,
            gate,
        }
    }
    fn service(&self) -> Service<'_, Fake> {
        Service {
            gate: &self.gate,
            platform: Fake {
                root: self.tree.root.clone(),
                info_calls: Cell::new(0),
                replace_second: false,
                consumers: false,
            },
        }
    }
    fn current(&self) -> GpuCurrentEmployee {
        reverie_host::gpu_access::current_employee(
            self.gate.inner.config().unwrap().configuration(),
            &employee(),
        )
        .unwrap()
    }
    fn queued(&self, enabled: bool) -> GpuQueuedRequest {
        let service = self.service();
        let config = self.gate.inner.config().unwrap();
        let binding = service
            .binding(config.configuration(), &self.current())
            .unwrap();
        let row = GpuQueuedRequest::try_new(
            1,
            JournalId::parse(SID).unwrap(),
            Generation::try_new(1).unwrap(),
            binding.digest().clone(),
            enabled.then(|| GpuDeviceUuid::parse(DEVICE).unwrap()),
        )
        .unwrap();
        let document = GpuRequestDocument::empty()
            .with_queued(employee(), row.clone())
            .unwrap();
        service
            .files(config.configuration())
            .unwrap()
            .publish_requests(&document, None)
            .unwrap();
        row
    }
}
struct Fake {
    root: PathBuf,
    info_calls: Cell<u32>,
    replace_second: bool,
    consumers: bool,
}
impl Platform for Fake {
    fn catalogue(&self) -> std::result::Result<Vec<GpuChoice>, GpuHostError> {
        Ok(vec![GpuChoice::try_new(
            GpuDeviceUuid::parse(DEVICE).unwrap(),
            "Owned fixture".into(),
        )?])
    }
    fn physical(&self, device: &GpuDeviceUuid) -> std::result::Result<PhysicalGpu, GpuHostError> {
        Ok(PhysicalGpu::selected(
            &format!(
                "GPU UUID: {}\nModel: Owned fixture\nBus Location: 0000:01:00.0\nDevice Minor: 0\n",
                device.as_str()
            ),
            &device.device(),
        )?
        .unwrap())
    }
    fn info(
        &self,
        _: Instant,
    ) -> std::result::Result<gpu_access::GpuEngineInformation, GpuHostError> {
        self.info_calls.set(self.info_calls.get() + 1);
        if self.replace_second && self.info_calls.get() == 2 {
            fs::write(self.root.join("cdi/device.json"), b"unparsed replacement").unwrap();
        }
        Ok(gpu_access::GpuEngineInformation::decode(
            &serde_json::to_vec(&json!({"OSType":"linux","CDISpecDirs":[self.root.join("cdi")]}))
                .unwrap(),
        )?)
    }
    fn cdi(
        &self,
        info: &gpu_access::GpuEngineInformation,
        device: &GpuDeviceUuid,
        end: Instant,
    ) -> std::result::Result<CdiObservation, GpuHostError> {
        GpuHardware::cdi(info, device, end)
    }
    fn active(
        &self,
        _: &UnsignedInteger,
        _: &PhysicalGpu,
    ) -> std::result::Result<(), GpuHostError> {
        panic!("no native active device in stopped fixture")
    }
    fn installed_consumers(
        &self,
        _: &EffectiveWorkerConfig,
    ) -> std::result::Result<bool, GpuHostError> {
        Ok(self.consumers)
    }
}
fn employee() -> JournalId {
    JournalId::parse(EID).unwrap()
}
fn end() -> Instant {
    Instant::now() + Duration::from_secs(20)
}
#[test]
fn actual_stopped_transition_updates_both_files_and_same_ram_tuple_then_releases_last_pending() {
    crate::test_process::owning_case!(
        actual_stopped_transition_updates_both_files_and_same_ram_tuple_then_releases_last_pending
    );
    for enabled in [false, true] {
        let setup = Setup::new(!enabled);
        let request = setup.queued(enabled);
        let old_profile =
            fs::read(setup.tree.root.join("control/operations/operations.json")).unwrap();
        setup.service().apply(&employee(), &request, end()).unwrap();
        let config = setup.gate.inner.config().unwrap();
        assert_eq!(
            gpu_access::applied(config.configuration(), setup.current().data())
                .unwrap()
                .device()
                .is_some(),
            enabled
        );
        let files = setup.service().files(config.configuration()).unwrap();
        assert!(gpu_access::private_config_matches(
            config.configuration(),
            files.read_configuration().unwrap().metadata()
        ));
        let (_, bound) = setup
            .gate
            .inner
            .installed
            .bound_resources(&setup.gate.inner.binding)
            .unwrap();
        assert!(bound.matches_metadata(files.read_binding().unwrap().metadata()));
        assert!(
            !setup
                .tree
                .root
                .join("state/resource-reservation-control.pending")
                .exists()
        );
        assert_eq!(
            fs::read(setup.tree.root.join("control/operations/operations.json")).unwrap(),
            old_profile
        );
        assert!(setup.gate.inner.failed_gpu.lock().unwrap().is_empty());
        assert!(setup.gate.inner.state.lock().unwrap().active.is_none());
        setup.gate.settle_owned(end()).unwrap();
    }
}
#[test]
fn cold_absent_queue_bypasses_company_and_native_observations() {
    let setup = Setup::new(false);
    fs::remove_file(setup.tree.root.join("company.json")).unwrap();
    setup
        .service()
        .cold(&ProfileSessionId::parse(SID).unwrap())
        .unwrap();
    assert!(setup.fixture.events().is_empty());
}
#[test]
fn invalid_source_custody_precedes_deferred_employee_and_leaves_no_transition() {
    crate::test_process::owning_case!(
        invalid_source_custody_precedes_deferred_employee_and_leaves_no_transition
    );
    let setup = Setup::new(false);
    fs::set_permissions(
        setup.tree.root.join("worker.json"),
        fs::Permissions::from_mode(0o644),
    )
    .unwrap();
    let command =
        gpu_access::decode_command(br#"{"action":"gpu-access-status","employeeId":null}"#).unwrap();
    let GpuCommand::Status(selector) = command else {
        panic!()
    };
    let error = setup
        .service()
        .status(Employee::Selector(selector), end())
        .err()
        .unwrap();
    assert_eq!(error.code(), "WORKER_IMAGE_CONFIGURATION_CUSTODY");
    assert!(
        !setup
            .tree
            .root
            .join("state/resource-reservation-control.pending")
            .exists()
    );
}

#[test]
fn failures_after_config_ram_close_or_final_pending_check_retain_real_record_and_never_replay() {
    crate::test_process::owning_case!(
        failures_after_config_ram_close_or_final_pending_check_retain_real_record_and_never_replay
    );
    use faults::{Action, Point};
    for (point, action) in [
        (Point::BeforePending, Action::ForeignPending),
        (Point::ConfigWritten, Action::ForeignBinding),
        (Point::RamPublished, Action::ChangedCdi),
        (Point::AdmissionClosed, Action::LostCloseAcknowledgement),
        (Point::BeforeRelease, Action::ForeignPending),
    ] {
        let setup = Setup::new(false);
        let row = setup.queued(true);
        let original = setup.tree.raw.clone();
        let marker = setup
            .tree
            .root
            .join("state/resource-reservation-control.json");
        faults::arm(point, action);
        let error = setup.service().apply(&employee(), &row, end()).unwrap_err();
        assert_eq!(error.code(), "GPU_APPLY_REQUIRES_RECONCILIATION");
        if point == Point::BeforePending {
            assert_eq!(
                fs::read(setup.tree.root.join("worker.json")).unwrap(),
                original
            );
        } else {
            assert_ne!(
                fs::read(setup.tree.root.join("worker.json")).unwrap(),
                original
            );
        }
        let pending = setup
            .tree
            .root
            .join("state/resource-reservation-control.pending");
        assert!(pending.exists());
        assert_eq!(setup.gate.inner.failed_gpu.lock().unwrap().len(), 1);
        assert!(setup.gate.inner.state.lock().unwrap().active.is_none());
        if point == Point::ConfigWritten {
            assert_eq!(fs::read(marker).unwrap(), b"foreign binding");
        }
        if matches!(point, Point::BeforePending | Point::BeforeRelease) {
            assert_eq!(fs::read(&pending).unwrap(), b"foreign pending");
        }
        let before = fs::read(&pending).unwrap();
        let event_count = setup.fixture.events().len();
        assert!(setup.gate.inner.admit(AdmissionBounds::default()).is_err());
        assert_eq!(
            setup.fixture.events().len(),
            event_count,
            "retained fence prevents another native constructor"
        );
        assert_eq!(fs::read(&pending).unwrap(), before);
        assert!(setup.gate.settle_owned(end()).is_err());
        assert_eq!(
            setup.fixture.events().last().unwrap(),
            "settle",
            "uncertain publication does not skip native settlement"
        );
    }
}
#[test]
fn full_request_status_and_stale_cold_intent_preserve_actual_queue_cas() {
    crate::test_process::owning_case!(
        full_request_status_and_stale_cold_intent_preserve_actual_queue_cas
    );
    let setup = Setup::new(false);
    let service = setup.service();
    let status = service
        .status(Employee::Checked(employee()), end())
        .unwrap();
    let expected = json!({"sessionId":status.current().session().as_str(),"sessionGeneration":status.current().generation().get(),"bindingDigest":status.current().digest().as_str(),"revision":0});
    let raw=serde_json::to_vec(&json!({"action":"gpu-access-request","employeeId":EID,"enabled":true,"deviceUuid":DEVICE,"expected":expected})).unwrap();
    let GpuCommand::Request {
        employee: selector,
        intent,
    } = gpu_access::decode_command(&raw).unwrap()
    else {
        panic!()
    };
    let applied = service.request(selector, intent, end()).unwrap();
    assert_eq!(applied.state().as_str(), "applied");
    assert_eq!(applied.requested().unwrap().revision(), 1);
    assert!(applied.applied().device().is_some());
    let queue = setup
        .tree
        .root
        .join("control/operations/gpu-owner-requests.json");
    let original = fs::read(&queue).unwrap();
    let GpuCommand::Request {
        employee: selector,
        intent,
    } = gpu_access::decode_command(&raw).unwrap()
    else {
        panic!()
    };
    assert_eq!(
        service
            .request(selector, intent, end())
            .err()
            .unwrap()
            .code(),
        "GPU_STALE_REQUEST"
    );
    assert_eq!(fs::read(&queue).unwrap(), original);
    // The queued digest predates its successful config/domain publication.
    // Generation rollover cannot silently refresh or rebind that old intent.
    setup.tree.write("company.json",&serde_json::to_vec(&json!({"employees":[{"id":EID,"sessionId":SID,"sessionGeneration":2,"owner":null}],"retired":[]})).unwrap());
    let before = fs::read(setup.tree.root.join("worker.json")).unwrap();
    service
        .cold(&ProfileSessionId::parse(SID).unwrap())
        .unwrap();
    assert_eq!(
        fs::read(setup.tree.root.join("worker.json")).unwrap(),
        before
    );
    assert_eq!(fs::read(queue).unwrap(), original);
}

#[test]
fn running_or_registered_consumer_keeps_intent_queued_without_mutating_configuration() {
    crate::test_process::owning_case!(
        running_or_registered_consumer_keeps_intent_queued_without_mutating_configuration
    );
    for running in [true, false] {
        let setup = Setup::with_worker(false, running.then_some(true));
        let request = setup.queued(true);
        let mut service = setup.service();
        service.platform.consumers = !running;
        service.apply(&employee(), &request, end()).unwrap();
        assert_eq!(
            fs::read(setup.tree.root.join("worker.json")).unwrap(),
            setup.tree.raw
        );
        assert!(
            !setup
                .tree
                .root
                .join("state/resource-reservation-control.pending")
                .exists()
        );
        assert!(setup.gate.inner.failed_gpu.lock().unwrap().is_empty());
    }
}
#[test]
fn post_info_replacement_is_refused_before_any_pending_or_configuration_publication() {
    crate::test_process::owning_case!(
        post_info_replacement_is_refused_before_any_pending_or_configuration_publication
    );
    let setup = Setup::new(false);
    let request = setup.queued(true);
    let mut service = setup.service();
    service.platform.replace_second = true;
    assert_eq!(
        service
            .apply(&employee(), &request, end())
            .unwrap_err()
            .code(),
        "GPU_CDI_OR_HARDWARE_CHANGED"
    );
    assert_eq!(service.platform.info_calls.get(), 2);
    assert_eq!(
        fs::read(setup.tree.root.join("worker.json")).unwrap(),
        setup.tree.raw
    );
    assert!(
        !setup
            .tree
            .root
            .join("state/resource-reservation-control.pending")
            .exists()
    );
    assert!(setup.gate.inner.failed_gpu.lock().unwrap().is_empty());
}
#[test]
fn original_operation_end_bounds_actual_lifecycle_contention_without_releasing_another_owner() {
    crate::test_process::owning_case!(
        original_operation_end_bounds_actual_lifecycle_contention_without_releasing_another_owner
    );
    let setup = Setup::new(false);
    let row = setup.queued(true);
    let installed = setup.gate.inner.installed.clone();
    let (entered_tx, entered_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let holder = std::thread::spawn(move || {
        let guard = installed.lifecycle().unwrap();
        entered_tx.send(()).unwrap();
        let explicitly_released = release_rx.recv_timeout(Duration::from_secs(8)).is_ok();
        drop(guard);
        explicitly_released
    });
    entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let started = Instant::now();
    let original_end = started + Duration::from_secs(5);
    let result = setup.service().apply(&employee(), &row, original_end);
    let finished = Instant::now();
    let _ = release_tx.send(());
    let released = holder.join().unwrap();
    assert!(
        finished.duration_since(started) < Duration::from_secs(7),
        "wait must use original five-second end, not wait for actual holder's eight-second control release"
    );
    assert!(
        released,
        "GPU cannot release another thread's real lifecycle guard"
    );
    assert_eq!(result.unwrap_err().code(), "GPU_APPLY_DEADLINE");
    assert!(
        setup
            .fixture
            .deadlines()
            .iter()
            .all(|end| *end == original_end)
    );
    assert_eq!(
        fs::read(setup.tree.root.join("worker.json")).unwrap(),
        setup.tree.raw
    );
    assert!(
        !setup
            .tree
            .root
            .join("state/resource-reservation-control.pending")
            .exists()
    );
    assert!(setup.gate.inner.failed_gpu.lock().unwrap().is_empty());
    assert!(setup.gate.inner.state.lock().unwrap().active.is_none());
    setup.service().apply(&employee(), &row, end()).unwrap();
}
