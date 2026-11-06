use super::*;
use reverie_contracts::{kernel_mounts::MountTable, worker_config};
use reverie_core::{decimal::UnsignedInteger, ids::ProfileSessionId, posix_path::PosixPath};
use serde_json::{Value, json};
use std::{collections::VecDeque, sync::Mutex};

struct State {
    outputs: VecDeque<String>,
    events: Vec<String>,
    deadlines: Vec<Instant>,
    meminfo: String,
    swap: UnsignedInteger,
    tables: VecDeque<MountTable>,
    effective: VecDeque<EffectiveWorkerConfig>,
    targets: Vec<[Vec<u32>; 3]>,
    storage: Option<[[u64; 4]; 3]>,
    after_storage: Option<Box<dyn FnOnce() -> std::io::Result<()> + Send>>,
    on_query: Option<Box<dyn FnMut() -> Result<()> + Send>>,
    original_runtime: Option<reverie_contracts::reservation_baseline::OriginalRuntimeTail>,
}
pub(crate) struct Fixture(Mutex<State>);
impl Fixture {
    pub(crate) fn new() -> Arc<Self> {
        Arc::new(Self(Mutex::new(State {
            outputs: VecDeque::new(),
            events: Vec::new(),
            deadlines: Vec::new(),
            meminfo: "MemTotal: 8388608 kB\nMemAvailable: 4194304 kB\n".to_owned(),
            swap: UnsignedInteger::from_u64(2 << 30),
            tables: VecDeque::from([MountTable::parse(&[]).unwrap()]),
            effective: VecDeque::new(),
            targets: Vec::new(),
            storage: None,
            after_storage: None,
            on_query: None,
            original_runtime: None,
        })))
    }
    pub(crate) fn observer(self: &Arc<Self>) -> NativeObserver {
        NativeObserver {
            source: Arc::new(self.clone()),
            cancellation: CancellationToken::new(),
        }
    }
    pub(crate) fn inventory(&self, rows: &[Value]) {
        let mut state = self.0.lock().unwrap();
        state.outputs.push_back(
            rows.iter()
                .map(|row| row["Id"].as_str().unwrap())
                .collect::<Vec<_>>()
                .join("\n"),
        );
        for batch in rows.chunks(32) {
            state.outputs.push_back(
                batch
                    .iter()
                    .map(Value::to_string)
                    .collect::<Vec<_>>()
                    .join("\n"),
            );
        }
    }
    pub(crate) fn events(&self) -> Vec<String> {
        self.0.lock().unwrap().events.clone()
    }
    pub(crate) fn deadlines(&self) -> Vec<Instant> {
        self.0.lock().unwrap().deadlines.clone()
    }
    pub(crate) fn storage_facts(&self, values: [[u64; 4]; 3]) {
        self.0.lock().unwrap().storage = Some(values);
    }
    pub(crate) fn after_storage(
        &self,
        hook: impl FnOnce() -> std::io::Result<()> + Send + 'static,
    ) {
        self.0.lock().unwrap().after_storage = Some(Box::new(hook));
    }
    pub(crate) fn on_query(&self, hook: impl FnMut() -> Result<()> + Send + 'static) {
        self.0.lock().unwrap().on_query = Some(Box::new(hook));
    }
    pub(crate) fn original_runtime(
        &self,
        tail: reverie_contracts::reservation_baseline::OriginalRuntimeTail,
    ) {
        self.0.lock().unwrap().original_runtime = Some(tail);
    }
}
impl Source for Arc<Fixture> {
    fn query(&self, query: EngineQuery<'_>, end: Instant, _: &CancellationToken) -> Result<String> {
        let mut state = self.0.lock().unwrap();
        state.events.push(
            match query {
                EngineQuery::InventoryIds => "ps",
                EngineQuery::InspectBatch(_) => "inspect",
                EngineQuery::InspectStopped(_) => "stopped",
            }
            .to_owned(),
        );
        state.deadlines.push(end);
        if let Some(hook) = state.on_query.as_mut() {
            hook()?;
        }
        state
            .outputs
            .pop_front()
            .ok_or(ObserverError::Refused("FIXTURE_QUERY_UNAVAILABLE"))
    }
    fn settle_owned(&self, _: Instant) -> Result<()> {
        self.0.lock().unwrap().events.push("settle".to_owned());
        Ok(())
    }
    fn host_root(&self, _: Instant) -> Result<HostAccounting> {
        let mut state = self.0.lock().unwrap();
        state.events.push("host".to_owned());
        Ok(HostAccounting::parse(&state.meminfo).unwrap())
    }
    fn mount_table(&self, _: Instant) -> Result<MountTable> {
        let mut state = self.0.lock().unwrap();
        state.events.push("table".to_owned());
        Ok(if state.tables.len() > 1 {
            state.tables.pop_front().unwrap()
        } else {
            state.tables[0].clone()
        })
    }
    fn limits(
        &self,
        row: &ContainerRow,
        policy: Option<&ObservedMemoryPolicy>,
        _: Instant,
    ) -> Result<NativeLimitBinding> {
        self.0
            .lock()
            .unwrap()
            .events
            .push(format!("limits:{}", row.id().as_str()));
        let zero = UnsignedInteger::from_u64(0);
        let declared = row.declarations(policy.map_or(&zero, ObservedMemoryPolicy::swap))?;
        Ok(NativeLimitBinding::from_observed_data(
            row,
            &declared,
            "77",
            &PosixPath::from_scalar_text("owned"),
            policy,
        )?)
    }
    fn custody_scan(
        &self,
        _: &ReservationConfiguration,
        targets: &reverie_host::reservation_kernel::CustodyPaths,
        _: &InventoryRows,
        _: &MountTable,
        _: Instant,
    ) -> Result<()> {
        let mut state = self.0.lock().unwrap();
        state.events.push("custody".to_owned());
        state
            .targets
            .push(targets.paths().map(|value| value.codepoints()));
        Ok(())
    }
    fn storage(
        &self,
        _: &ReservationConfiguration,
        _: &ContainerRow,
        _: &StoragePaths,
        _: Instant,
    ) -> Result<NativeStorageBinding> {
        let (facts, hook) = {
            let mut state = self.0.lock().unwrap();
            state.events.push("storage".to_owned());
            (state.storage, state.after_storage.take())
        };
        let facts = facts.ok_or(ObserverError::Refused("FIXTURE_STORAGE_NOT_SELECTED"))?;
        if let Some(hook) = hook {
            hook().map_err(|error| {
                ObserverError::Kernel(
                    reverie_host::reservation_kernel::ReservationKernelError::Observation(
                        error.into(),
                    ),
                )
            })?;
        }
        Ok(NativeStorageBinding::from_observed_data(facts))
    }
    fn swap_total(&self, _: Instant) -> Result<UnsignedInteger> {
        let mut state = self.0.lock().unwrap();
        state.events.push("swap".to_owned());
        Ok(state.swap.clone())
    }
    fn original_runtime_tail(
        &self,
        _: &ContainerRow,
        _: &NativeLimitBinding,
        _: Instant,
    ) -> Result<reverie_contracts::reservation_baseline::OriginalRuntimeTail> {
        let mut state = self.0.lock().unwrap();
        state.events.push("original-runtime".into());
        state.original_runtime.clone().ok_or(ObserverError::Refused(
            "FIXTURE_ORIGINAL_RUNTIME_UNAVAILABLE",
        ))
    }
    fn effective_config(
        &self,
        config: EffectiveWorkerConfig,
        _: &ProfileSessionId,
    ) -> Result<EffectiveWorkerConfig> {
        let mut state = self.0.lock().unwrap();
        state.events.push("effective".to_owned());
        Ok(state.effective.pop_front().unwrap_or(config))
    }
}
fn configuration() -> EffectiveWorkerConfig {
    worker_config::decode(br#"{"deployment":"office","serverContainer":"website","poolMemoryMiB":2048,"uid":1000,"stateRoot":"/owned/state","image":"old","resourceReservations":{"directory":"/owned/control","hostReserveMiB":512}}"#).unwrap()
}
fn row(id: u64, worker: bool) -> Value {
    json!({"Id":format!("{id:064x}"),"Name":if worker {"/agent"} else {"/website"},"Image":format!("sha256:{}","a".repeat(64)),"Config":{"Labels":if worker {json!({"reverie.worker":"foreign"})} else {json!({})}},"State":{"Running":true,"Pid":123},"Mounts":[],"HostConfig":{"Memory":536870912,"MemorySwap":536870912,"PidsLimit":128,"NanoCpus":0}})
}
fn result_code<T>(result: Result<T>) -> Option<&'static str> {
    result.err().map(|error| error.code())
}
#[test]
fn complete_batched_census_has_one_deadline_and_cannot_be_rebound_to_another_context() {
    let fixture = Fixture::new();
    let rows = (1..=35).map(|id| row(id, true)).collect::<Vec<_>>();
    fixture.inventory(&rows);
    let observer = fixture.observer();
    let end = Instant::now() + Duration::from_secs(4);
    let context = observer.capture(configuration(), Some(end));
    let census = context.inventory(None).unwrap();
    assert_eq!(census.rows().count(), 35);
    assert_eq!(fixture.events(), ["ps", "inspect", "inspect"]);
    assert!(
        fixture
            .0
            .lock()
            .unwrap()
            .deadlines
            .iter()
            .all(|value| *value == end)
    );
    let other = observer.capture(configuration(), None);
    assert_eq!(
        result_code(other.limits(&census.rows().next().unwrap())),
        Some("RESERVATION_OBSERVATION_CONTEXT")
    );
    assert_eq!(fixture.events().len(), 3);
}
#[test]
fn owned_context_retains_one_engine_origin_but_equal_data_does_not_rebind_rows() {
    let fixture = Fixture::new();
    fixture.inventory(&[row(1, true)]);
    fixture.inventory(&[row(1, true)]);
    let observer = fixture.observer();
    let retained = observer.capture(configuration(), None);
    let second = observer.clone().capture(configuration(), None);
    let cancellation = observer.cancellation();
    drop(observer);
    let first = retained.inventory(None).unwrap();
    let equal = second.inventory(None).unwrap();
    assert!(first.equivalent(&equal));
    assert_eq!(
        result_code(second.limits(&first.rows().next().unwrap())),
        Some("RESERVATION_OBSERVATION_CONTEXT")
    );
    assert_eq!(fixture.events(), ["ps", "inspect", "ps", "inspect"]);
    cancellation.cancel();
    assert_eq!(
        result_code(retained.host_root()),
        Some("RESERVATION_OBSERVATION_CANCELLED")
    );
    assert_eq!(
        result_code(second.host_root()),
        Some("RESERVATION_OBSERVATION_CANCELLED")
    );
    assert_eq!(fixture.events().len(), 4);
}
#[test]
fn invalid_earlier_batch_json_prevents_a_later_native_query() {
    let fixture = Fixture::new();
    let ids = (1..=35).map(|id| format!("{id:064x}")).collect::<Vec<_>>();
    let mut lines = vec!["{}"; 32];
    lines[0] = "{";
    fixture.0.lock().unwrap().outputs = VecDeque::from([ids.join("\n"), lines.join("\n")]);
    let observer = fixture.observer();
    let context = observer.capture(configuration(), None);
    assert_eq!(
        result_code(context.inventory(None)),
        Some("RESERVATION_ENGINE_JSON")
    );
    assert_eq!(fixture.events(), ["ps", "inspect"]);
}
#[test]
fn capacity_includes_foreign_workers_and_explicit_pool_and_host_budgets() {
    let fixture = Fixture::new();
    fixture.inventory(&[row(1, false), row(2, true)]);
    let observer = fixture.observer();
    let context = observer.capture(configuration(), None);
    let census = context.inventory(None).unwrap();
    let facts = context.capacity(&census).unwrap();
    assert_eq!(facts.total().as_str(), "536870912");
    assert_eq!(facts.commitments().len(), 1);
    assert_eq!(facts.budget().as_str(), "2147483648");
    fixture.0.lock().unwrap().meminfo = "MemTotal: 8388608 kB\nMemAvailable: 1 kB\n".to_owned();
    assert_eq!(
        result_code(context.capacity(&census)),
        Some("RESERVATION_HOST_BUDGET")
    );
}
#[test]
fn swap_commitments_and_actual_swap_total_both_bound_capacity() {
    for (pool, actual, expected) in [
        (256, 512, None),
        (
            256,
            128,
            Some("Laptop swap pool exceeds actual host swap capacity"),
        ),
        (128, 512, Some("Laptop swap admission is full")),
    ] {
        let fixture = Fixture::new();
        let mut worker = row(2, true);
        let effective =
            worker_config::decode(br#"{"memoryMiB":512,"laptopMemoryPolicy":{"swapMiB":256}}"#)
                .unwrap();
        worker["HostConfig"]["MemorySwap"] = json!(805306368);
        worker["Config"]["Labels"] = json!({"reverie.worker":"office","reverie.session":"00000000-0000-0000-0000-000000000000","reverie.worker-policy":policy_digest(&effective).to_hex()});
        fixture.inventory(&[row(1, false), worker]);
        {
            let mut state = fixture.0.lock().unwrap();
            state.effective = VecDeque::from([effective.clone(), effective]);
            state.swap = UnsignedInteger::from_u64(actual * 1_048_576);
        }
        let mut data: Value =
            serde_json::from_slice(&worker_config::encode_config(&configuration())).unwrap();
        data["employeeMemoryPolicies"] = json!({"enabled":"opaque truthy"});
        data["laptopSwapPoolMiB"] = json!(pool);
        let observer = fixture.observer();
        let context = observer.capture(
            worker_config::decode(&serde_json::to_vec(&data).unwrap()).unwrap(),
            None,
        );
        let census = context.inventory(None).unwrap();
        assert_eq!(result_code(context.capacity(&census)), expected);
        let events = fixture.events();
        assert_eq!(
            events.iter().filter(|event| *event == "effective").count(),
            2
        );
        assert_eq!(
            events.iter().filter(|event| *event == "swap").count(),
            usize::from(pool == 256)
        );
    }
}
#[test]
fn ordinary_stopped_validation_happens_before_fresh_engine_query() {
    let fixture = Fixture::new();
    fixture.inventory(&[row(1, true)]);
    let observer = fixture.observer();
    let context = observer.capture(configuration(), None);
    let census = context.inventory(None).unwrap();
    assert_eq!(
        result_code(context.stopped_state(&census.rows().next().unwrap(), None)),
        Some("RESERVATION_STOPPED_ROW")
    );
    assert_eq!(fixture.events(), ["ps", "inspect"]);
}
#[test]
fn custody_rechecks_full_mount_shape_but_does_not_replace_first_census() {
    let fixture = Fixture::new();
    let first = row(1, true);
    let mut second = first.clone();
    second["Name"] = json!("/changed-only-name");
    fixture.inventory(&[first]);
    fixture.inventory(&[second]);
    let observer = fixture.observer();
    let context = observer.capture(configuration(), None);
    let census = context.custody(None).unwrap();
    assert!(census.rows().next().unwrap().data().name_is("/agent"));
    assert_eq!(
        fixture.events(),
        [
            "table", "ps", "inspect", "custody", "table", "ps", "inspect"
        ]
    );
}
#[test]
fn actual_image_target_uses_same_context_engine_deadline_and_complete_census() {
    use std::os::unix::fs::PermissionsExt;
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    struct Owned(std::path::PathBuf);
    impl Drop for Owned {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.0).unwrap();
        }
    }
    let root = Owned(std::env::temp_dir().join(format!(
        "reverie-custody-image-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    )));
    std::fs::create_dir(&root.0).unwrap();
    let path = root.0.join("owner.config.json");
    std::fs::write(&path, b"{\"image\":\"old\"}").unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    let config = configuration();
    let image = reverie_host::reservation_control::capture_current_image(&path, &config).unwrap();
    let fixture = Fixture::new();
    fixture.inventory(&[row(1, true)]);
    fixture.inventory(&[row(1, true)]);
    let observer = fixture.observer();
    let end = Instant::now() + Duration::from_secs(3);
    let context = observer.capture(config, Some(end));
    let census = context.custody_current_image(&image, None).unwrap();
    assert_eq!(census.rows().count(), 1);
    let state = fixture.0.lock().unwrap();
    assert_eq!(
        state.events,
        [
            "table", "ps", "inspect", "custody", "table", "ps", "inspect"
        ]
    );
    assert!(state.deadlines.iter().all(|value| *value == end));
    assert_eq!(state.targets.len(), 1);
    assert_eq!(
        state.targets[0],
        [
            PosixPath::from_scalar_text("/owned/control").codepoints(),
            PosixPath::from_scalar_text(path.to_str().unwrap()).codepoints(),
            PosixPath::from_scalar_text(root.0.join("owner.config.pending").to_str().unwrap())
                .codepoints()
        ]
    );
}
#[test]
fn expired_or_cancelled_observations_never_query_and_cleanup_does_not_retry() {
    let fixture = Fixture::new();
    let observer = fixture.observer();
    let expired = observer.capture(
        configuration(),
        Some(Instant::now() - Duration::from_secs(1)),
    );
    assert_eq!(
        result_code(expired.inventory(None)),
        Some("RESERVATION_OBSERVATION_DEADLINE")
    );
    observer.cancellation().cancel();
    let context = observer.capture(configuration(), None);
    assert_eq!(
        result_code(context.inventory(None)),
        Some("RESERVATION_OBSERVATION_CANCELLED")
    );
    observer
        .settle_owned(Instant::now() + Duration::from_secs(1))
        .unwrap();
    assert_eq!(fixture.events(), ["settle"]);
}
