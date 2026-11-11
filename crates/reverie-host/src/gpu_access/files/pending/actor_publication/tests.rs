//! Actual private files and admission. Fixture actor facts are metadata only.
use super::*;
use crate::{
    engine_metadata::EngineBootstrap,
    installed_worker_engine::InstalledWorkerEngine,
    reservation_control::{AdmissionLockAttempt, tests::Tree},
    resource_facts::InstalledFactsObserver,
    worker_runtime::WorkerRuntime,
};
use reverie_contracts::{
    gpu_access::GpuCandidate, resource_actor::ResourceActorSettings, worker_config,
};
use reverie_core::{
    gpu_access::GpuQueuedRequest,
    operations::{JournalDigest, JournalId},
    resources::{BudgetMode, CpuQuota, ResourcePolicy},
    revision::Generation,
    worker_schema::{WorkerBase, WorkerIds},
};
use serde_json::{Value, json};
use std::{collections::BTreeMap, time::Duration};
const EID: &str = "11111111-2222-4333-8444-555555555555";
const SID: &str = "22222222-2222-4333-8444-555555555555";
const DEVICE: &str = "GPU-11111111-2222-3333-4444-555555555555";

struct Fixture {
    tree: Tree,
    files: GpuControlFiles,
    intent: Arc<GpuTransitionIntent>,
    actor: InstalledFactsObserver,
    runtime: WorkerRuntime,
    end: Instant,
}
impl Fixture {
    fn new() -> Self {
        let mut tree = Tree::new();
        let before = write_original(&mut tree);
        let bound = tree.binding();
        let source = tree.root.join("broker.json");
        let files = GpuControlFiles::capture(&source, &before);
        let employee = JournalId::parse(EID).unwrap();
        let queued = GpuQueuedRequest::try_new(
            1,
            JournalId::parse(SID).unwrap(),
            Generation::try_new(1).unwrap(),
            JournalDigest::parse(&"a".repeat(64)).unwrap(),
            None,
        )
        .unwrap();
        files
            .publish_requests(
                &GpuRequestDocument::empty()
                    .with_queued(employee.clone(), queued.clone())
                    .unwrap(),
                None,
            )
            .unwrap();
        tree.write(
            "control/operations/task-perf-owner-requests.json",
            b"private fixture history",
        );
        let candidate = GpuCandidate::project(&before, &employee, None).unwrap();
        let intent =
            Arc::new(GpuTransitionIntent::capture(&candidate, &employee, &queued, &bound).unwrap());
        let mut actor = InstalledFactsObserver::default();
        let end = Instant::now() + Duration::from_secs(15);
        actor.observe(&before, end).unwrap();
        let runtime = fixture_runtime(&tree);
        Self {
            tree,
            files,
            intent,
            actor,
            runtime,
            end,
        }
    }
    fn pending(&self, lock: &AdmissionLock) -> GpuPendingFile {
        let request = self.files.read_requests().unwrap().unwrap();
        self.files
            .publish_pending_with_actor(
                self.intent.clone(),
                self.end,
                lock,
                &self.runtime.stop_budget(),
                request.stamp(),
            )
            .unwrap()
    }
}
fn write_original(tree: &mut Tree) -> EffectiveWorkerConfig {
    let mut value: Value =
        serde_json::from_slice(&worker_config::encode_config(tree.config.configuration())).unwrap();
    value["resourceActorConfig"] = json!(tree.root.join("control/resource-actor.json"));
    value["gid"] = json!(nix::unistd::getgid().as_raw());
    value["employeeGpuGrants"] = json!({EID: format!("nvidia.com/gpu={DEVICE}")});
    let mut raw = serde_json::to_vec(&value).unwrap();
    assert_eq!(raw.pop(), Some(b'}'));
    raw.extend_from_slice(br#", "sessionResources": {"ffffffff-ffff-4fff-8fff-ffffffffffff": {}, "11111111-1111-4111-8111-111111111111": {}}}"#);
    let before = worker_config::decode(&raw).unwrap();
    tree.config = ReservationConfiguration::capture(before.clone());
    tree.write("broker.json", &raw);
    tree.marker(&[".", "profiles", "operations"]);
    let settings = ResourceActorSettings::capture(&before).unwrap();
    let document = crate::resource_facts::tests::document(
        settings.domain().as_str(),
        settings.uid(),
        settings.gid(),
    );
    tree.write(
        "control/resource-actor.json",
        &serde_json::to_vec(&document).unwrap(),
    );
    before
}
fn fixture_runtime(tree: &Tree) -> WorkerRuntime {
    let base = WorkerBase::try_new(
        "fixture".into(),
        "fixture-web".into(),
        format!("sha256:{}", "a".repeat(64)),
        WorkerIds::try_new(1000, 1000).unwrap(),
        1,
        ResourcePolicy::try_new(
            BudgetMode::Admission,
            1024,
            128,
            CpuQuota::from_integer(1).unwrap(),
            8192,
            512,
        )
        .unwrap(),
    )
    .unwrap();
    let executable = std::env::current_exe().unwrap();
    let bootstrap =
        EngineBootstrap::from_service(executable.as_os_str(), BTreeMap::new(), tree.root.clone())
            .unwrap();
    WorkerRuntime::new(InstalledWorkerEngine::new(bootstrap), &base)
}

#[test]
fn actual_three_cas_rebinds_original_actor_and_releases_same_pending_after_r_close() {
    let mut fixture = Fixture::new();
    let plan = fixture
        .actor
        .prepare_configuration_rebind(fixture.intent.before(), fixture.intent.after())
        .unwrap();
    let mut lock = AdmissionLock::acquire(&fixture.tree.config).unwrap();
    let configuration = fixture.files.read_configuration().unwrap();
    let binding = fixture.files.read_binding().unwrap();
    let mut pending = fixture.pending(&lock);
    let published = pending
        .publish_actor(
            &fixture.files,
            GpuActorPublicationInput {
                configuration: configuration.stamp(),
                binding: binding.stamp(),
                actor: &plan,
                admission: &lock,
                cdi: None,
            },
            vec![fixture.tree.root.join("fixed-terminal-fixture")],
        )
        .unwrap();
    assert!(pending.release().is_err());
    assert_eq!(
        pending.release_with_actor(&published).unwrap_err().code(),
        "RESERVATION_ORIGINAL_ADMISSION_CLOSE_UNCONFIRMED"
    );
    published.assert_current().unwrap();
    let applied = fixture
        .actor
        .accept_configuration_rebind(published.actor())
        .unwrap();
    ResourceActorSettings::capture(fixture.intent.after())
        .unwrap()
        .require_document(&applied)
        .unwrap();
    assert!(
        fixture
            .intent
            .after_binding()
            .matches_metadata(fixture.files.read_binding().unwrap().metadata())
    );
    let current =
        worker_config::decode(&fs::read(fixture.tree.root.join("broker.json")).unwrap()).unwrap();
    assert!(worker_config::equivalent(&current, fixture.intent.after()));
    assert_eq!(
        current.session_resource_order(),
        fixture.intent.before().session_resource_order()
    );
    assert_eq!(
        fs::read(
            fixture
                .tree
                .root
                .join("control/operations/task-perf-owner-requests.json")
        )
        .unwrap(),
        b"private fixture history"
    );
    let name = pending.path().to_owned();
    lock.close().unwrap();
    pending.release_with_actor(&published).unwrap();
    assert!(!name.exists());
    fixture.runtime.close(fixture.end).unwrap();
}
#[test]
fn terminal_appearance_after_source_cas_retains_original_pending_and_prevents_replay() {
    let mut fixture = Fixture::new();
    let plan = fixture
        .actor
        .prepare_configuration_rebind(fixture.intent.before(), fixture.intent.after())
        .unwrap();
    let mut lock = AdmissionLock::acquire(&fixture.tree.config).unwrap();
    let configuration = fixture.files.read_configuration().unwrap();
    let binding = fixture.files.read_binding().unwrap();
    let mut pending = fixture.pending(&lock);
    let terminal = fixture.tree.root.join("fixed-terminal-fixture");
    let path = terminal.clone();
    crate::gpu_access::files::tests::hook(
        crate::gpu_access::files::tests::Point::Renamed,
        move |_, _| {
            fs::write(path, b"retained terminal")?;
            Ok(())
        },
    );
    let input = || GpuActorPublicationInput {
        configuration: configuration.stamp(),
        binding: binding.stamp(),
        actor: &plan,
        admission: &lock,
        cdi: None,
    };
    let error = pending
        .publish_actor(&fixture.files, input(), vec![terminal.clone()])
        .err()
        .unwrap();
    assert!(error.is_uncertain());
    let custody = pending.actor_custody.as_ref().unwrap();
    assert_eq!(&custody.configuration.before, configuration.stamp());
    assert_eq!(
        custody.configuration.after.as_ref(),
        Some(fixture.files.read_configuration().unwrap().stamp())
    );
    assert_eq!(&custody.binding.before, binding.stamp());
    assert!(custody.binding.after.is_none());
    assert_ne!(
        fixture.files.read_configuration().unwrap().stamp(),
        configuration.stamp()
    );
    assert_eq!(
        fixture.files.read_binding().unwrap().stamp(),
        binding.stamp()
    );
    fixture
        .actor
        .assert_metadata(fixture.intent.before(), fixture.end)
        .unwrap();
    fs::remove_file(&terminal).unwrap();
    assert_eq!(
        pending
            .publish_actor(&fixture.files, input(), vec![terminal])
            .err()
            .unwrap()
            .code(),
        "GPU_APPLY_REQUIRES_RECONCILIATION"
    );
    lock.close().unwrap();
    assert!(pending.path().exists());
    assert!(pending.release().is_err());
    fixture.runtime.close(fixture.end).unwrap();
}

#[test]
fn replaced_queue_and_reacquired_admission_never_enter_protected_cas() {
    let mut fixture = Fixture::new();
    let plan = fixture
        .actor
        .prepare_configuration_rebind(fixture.intent.before(), fixture.intent.after())
        .unwrap();
    let mut original = AdmissionLock::acquire(&fixture.tree.config).unwrap();
    let configuration = fixture.files.read_configuration().unwrap();
    let binding = fixture.files.read_binding().unwrap();
    let mut pending = fixture.pending(&original);
    let previous = fixture.files.read_requests().unwrap().unwrap();
    fixture
        .files
        .publish_requests(&GpuRequestDocument::empty(), Some(previous.stamp()))
        .unwrap();
    let input = GpuActorPublicationInput {
        configuration: configuration.stamp(),
        binding: binding.stamp(),
        actor: &plan,
        admission: &original,
        cdi: None,
    };
    let terminal = fixture.tree.root.join("fixed-terminal-fixture");
    let error = pending
        .publish_actor(&fixture.files, input, vec![terminal.clone()])
        .err()
        .unwrap();
    assert_eq!(error.code(), "GPU_REQUEST_CHANGED");
    original.close().unwrap();
    // Another test's concurrent fork can briefly inherit the close-on-exec
    // descriptor. Wait only for a clean contention result on this fixture.
    let mut later = loop {
        assert!(
            Instant::now() < fixture.end,
            "fresh fixture admission timed out"
        );
        match AdmissionLock::try_acquire(&fixture.tree.config).unwrap() {
            AdmissionLockAttempt::Acquired(lock) => break lock,
            AdmissionLockAttempt::Contended => std::thread::sleep(Duration::from_millis(1)),
        }
    };
    let input = GpuActorPublicationInput {
        configuration: configuration.stamp(),
        binding: binding.stamp(),
        actor: &plan,
        admission: &later,
        cdi: None,
    };
    let error = pending
        .publish_actor(&fixture.files, input, vec![terminal])
        .err()
        .unwrap();
    assert_eq!(error.code(), "GPU_ORIGINAL_ADMISSION_CHANGED");
    assert_eq!(
        fixture.files.read_configuration().unwrap().stamp(),
        configuration.stamp()
    );
    assert_eq!(
        fixture.files.read_binding().unwrap().stamp(),
        binding.stamp()
    );
    assert!(pending.path().exists());
    later.close().unwrap();
    fixture.runtime.close(fixture.end).unwrap();
}

#[test]
fn known_third_write_stamp_survives_failed_actor_receipt_assembly() {
    let mut fixture = Fixture::new();
    let plan = fixture
        .actor
        .prepare_configuration_rebind(fixture.intent.before(), fixture.intent.after())
        .unwrap();
    let mut lock = AdmissionLock::acquire(&fixture.tree.config).unwrap();
    let configuration = fixture.files.read_configuration().unwrap();
    let binding = fixture.files.read_binding().unwrap();
    let mut pending = fixture.pending(&lock);
    let observed = Arc::new(std::sync::Mutex::new(None));
    let recorded = Arc::clone(&observed);
    crate::gpu_access::files::tests::hook(
        crate::gpu_access::files::tests::Point::ActorReadback,
        move |parent, leaf| {
            let target = parent.join(leaf);
            *recorded.lock().unwrap() = Some(GpuFileStamp::observe(&target)?);
            fs::rename(&target, parent.join("retained-actor-after"))?;
            fs::write(target, b"changed after actual checked CAS")?;
            Ok(())
        },
    );
    let error = pending
        .publish_actor(
            &fixture.files,
            GpuActorPublicationInput {
                configuration: configuration.stamp(),
                binding: binding.stamp(),
                actor: &plan,
                admission: &lock,
                cdi: None,
            },
            vec![fixture.tree.root.join("fixed-terminal-fixture")],
        )
        .err()
        .unwrap();
    assert!(error.is_uncertain());
    let custody = pending.actor_custody.as_ref().unwrap();
    assert!(custody.configuration.after.is_some() && custody.binding.after.is_some());
    let expected = observed.lock().unwrap().take().unwrap();
    assert_eq!(custody.actor_stamp.as_ref(), Some(&expected));
    assert!(pending.path().is_file());
    lock.close().unwrap();
    assert!(pending.release().is_err());
    fixture.runtime.close(fixture.end).unwrap();
}

#[test]
fn known_protected_pending_owner_survives_changed_named_readback() {
    let fixture = Fixture::new();
    let mut lock = AdmissionLock::acquire(&fixture.tree.config).unwrap();
    let mut pending = fixture.pending(&lock);
    let original = pending.stamp().clone();
    let archived = fixture.tree.root.join("retained-original-pending");
    fs::rename(pending.path(), &archived).unwrap();
    fs::copy(&archived, pending.path()).unwrap();
    assert_eq!(
        pending.assert_current(&fixture.files).unwrap_err().code(),
        "GPU_TRANSITION_PENDING_CHANGED"
    );
    assert_eq!(pending.stamp(), &original);
    assert!(pending.file.unreleased());
    assert_eq!(fs::read(&archived).unwrap(), fixture.intent.bytes());
    lock.close().unwrap();
    assert!(pending.release().is_err());
    fixture.runtime.close(fixture.end).unwrap();
}
