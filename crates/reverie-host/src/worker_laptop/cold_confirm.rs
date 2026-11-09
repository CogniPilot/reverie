//! Fixed actual Created CID/PID/mount observation. The private confirmation is
//! minted only while borrowing this retained laptop record and its real owners.
use super::call_budget::CallBudget;
use super::*;
use crate::{
    native,
    reservation_kernel::ReservationKernel,
    worker_storage::{LaunchStorage, StorageOwnershipKind},
};
use reverie_contracts::{
    resource_config::ResourceIdentitySettings,
    storage_identity::MetadataText,
    worker_cold_tmp::{ReferenceProcessIdentity, RetainedInspection, RetainedNativeRecord},
};
use reverie_core::{decimal::UnsignedInteger, ids::ContainerId, posix_path::PosixPath};
use reverie_store::storage_identity::{self, StorageIdentityConfig};
use std::os::unix::fs::MetadataExt;
#[derive(Clone)]
pub(crate) struct Confirmed {
    origin: Arc<InstalledWorkerEngine>,
    owner: Arc<()>,
    container: ContainerId,
    image: MetadataText,
    pid: UnsignedInteger,
    start: String,
}
impl Confirmed {
    pub(crate) fn matches_storage(
        &self,
        storage: &LaunchStorage,
        origin: &Arc<InstalledWorkerEngine>,
    ) -> bool {
        Arc::ptr_eq(&self.owner, storage.owner_identity()) && Arc::ptr_eq(&self.origin, origin)
    }
    pub(crate) fn same(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.origin, &other.origin)
            && Arc::ptr_eq(&self.owner, &other.owner)
            && self.container == other.container
            && self.image == other.image
            && self.pid == other.pid
            && self.start == other.start
    }
    pub(crate) fn record(&self) -> RetainedNativeRecord<'_> {
        RetainedNativeRecord {
            container: &self.container,
            image: &self.image,
            pid: &self.pid,
            start: &self.start,
        }
    }
}
pub(super) fn confirm(
    runtime: &WorkerRuntime,
    record: &mut Record,
    budget: CallBudget,
) -> Result<Confirmed> {
    current(runtime, record, budget)?;
    let container = record
        .creation
        .as_ref()
        .and_then(|creation| creation.container.clone())
        .ok_or(LaptopError::Refused(
            "WORKER_COLD_ACTUAL_CREATED_CID_REQUIRED",
        ))?;
    let row = inspect(runtime, record, &container, budget)?;
    let start = start(runtime, &row, budget)?;
    mounts(runtime, record, &row, budget)?;
    need(
        row.same_observation(&inspect(runtime, record, &container, budget)?)
            .map_err(data)?,
        "WORKER_COLD_NATIVE_CHANGED",
    )?;
    need(
        start == self::start(runtime, &row, budget)?,
        "WORKER_COLD_NATIVE_PID_CHANGED",
    )?;
    current(runtime, record, budget)?;
    Ok(Confirmed {
        origin: runtime.installed_engine().clone(),
        owner: record.resources().storage().owner_identity().clone(),
        container,
        image: row.image().clone(),
        pid: row.pid().clone(),
        start,
    })
}
fn current(runtime: &WorkerRuntime, record: &Record, budget: CallBudget) -> Result<()> {
    super::cold::running_budget(runtime, budget)?;
    let resources = record.resources();
    let storage = resources.storage();
    resources
        .held_nix()?
        .assert_create_plan(runtime, &resources.plan)
        .map_err(LaptopError::Plan)?;
    resources
        .held_nix()?
        .assert_cold_resources_current()
        .map_err(LaptopError::Nix)?;
    let source = resources.plan.source();
    let settings = ResourceIdentitySettings::capture_worker_config(source).map_err(|error| {
        LaptopError::ColdStorage(crate::worker_storage::StorageOwnerError::Settings(error))
    })?;
    let config = StorageIdentityConfig::capture_worker_settings(&settings);
    need(
        storage_identity::storage_paths(&config, storage.paths().session())
            .map_err(LaptopError::Identity)?
            == *storage.paths()
            && storage_identity::storage_start_allowed(&config, storage.paths())
                .map_err(LaptopError::Identity)?,
        "WORKER_COLD_CURRENT_INTENT_CHANGED",
    )?;
    need(
        storage
            .check_resource_current()
            .map_err(LaptopError::ColdStorage)?
            == StorageOwnershipKind::HeldLease,
        "WORKER_COLD_EMPLOYEE_LEASE_REQUIRED",
    )?;
    storage
        .require_cold_prepared(source)
        .map_err(LaptopError::ColdStorage)
}
fn inspect(
    runtime: &WorkerRuntime,
    record: &mut Record,
    cid: &ContainerId,
    budget: CallBudget,
) -> Result<RetainedInspection> {
    super::cold::running_budget(runtime, budget)?;
    let output = network::call_with_budget(
        runtime,
        record,
        vec!["inspect".into(), cid.as_str().into()],
        network::CallPurpose::Observe,
        budget,
    )?;
    need(output.succeeded, "WORKER_COLD_NATIVE_INSPECT_FAILED")?;
    let resources = record.resources();
    RetainedInspection::decode_started(
        &output.stdout,
        cid,
        resources.plan.source(),
        resources.plan.effective_configuration(),
        resources.plan.session(),
        resources
            .storage()
            .paths()
            .employee()
            .map(|_| resources.storage().paths().identity()),
    )
    .map_err(data)
}
fn start(runtime: &WorkerRuntime, row: &RetainedInspection, budget: CallBudget) -> Result<String> {
    super::cold::running_budget(runtime, budget)?;
    let raw = native::read_reservation(
        &std::path::PathBuf::from(format!("/proc/{}/stat", row.pid().as_str())),
        65536,
    )
    .map_err(LaptopError::Observation)?;
    let raw = std::str::from_utf8(&raw)
        .map_err(|_| LaptopError::Refused("WORKER_COLD_NATIVE_STAT_ENCODING"))?;
    Ok(ReferenceProcessIdentity::parse(raw)
        .map_err(data)?
        .start()
        .to_owned())
}
fn mounts(
    runtime: &WorkerRuntime,
    record: &Record,
    row: &RetainedInspection,
    budget: CallBudget,
) -> Result<()> {
    let resources = record.resources();
    let storage = resources.storage();
    let (key, retained) = storage
        .retained_native_target()
        .map_err(LaptopError::ColdStorage)?;
    let config = ResourceIdentitySettings::capture_worker_config(resources.plan.source()).map_err(
        |error| LaptopError::ColdStorage(crate::worker_storage::StorageOwnerError::Settings(error)),
    )?;
    let target = PosixPath::try_new(&native::python_text(&storage.paths().scratch().join("tmp")))
        .expect("filesystem codepoints");
    let info =
        std::fs::metadata(native::python_path(&target.codepoints()).map_err(LaptopError::Io)?)
            .map_err(LaptopError::Io)?;
    need(
        (info.dev(), info.ino()) == key
            && info.uid() == config.uid()
            && info.mode() & 0o7777 == 0o700,
        "WORKER_COLD_FRESH_TMP_CHANGED",
    )?;
    row.require_tmp_bind(&MetadataText::from_python_text(
        reverie_core::PythonText::try_new(target.codepoints()).expect("checked path codepoints"),
    ))
    .map_err(data)?;
    let kernel = ReservationKernel::new();
    let host = kernel
        .mount_table(budget.end(runtime, 30))
        .map_err(LaptopError::MemoryKernel)?;
    let container = kernel
        .cold_process_mounts(row.pid().as_str(), budget.end(runtime, 30))
        .map_err(LaptopError::MemoryKernel)?;
    let location = kernel
        .cold_reference_location(&target, &host, budget.end(runtime, 30))
        .map_err(LaptopError::MemoryKernel)?;
    let selected = container
        .rows()
        .iter()
        .filter(|row| row.point() == &PosixPath::from_scalar_text("/tmp"))
        .collect::<Vec<_>>();
    need(
        selected.len() == 1
            && selected[0].device() == &location.0
            && selected[0].root() == Some(&location.1),
        "WORKER_COLD_ACTUAL_TMP_BIND_CHANGED",
    )?;
    for bind in row.row().mounts().map_err(data)? {
        if let Some(bind) = bind.map_err(data)? {
            let real = native::resolve_strict_text(bind.source().map_err(data)?.codepoints())
                .map_err(LaptopError::Io)?;
            let destination = PosixPath::try_new(bind.destination().map_err(data)?.codepoints())
                .map_err(|_| LaptopError::Refused("WORKER_COLD_BIND_DESTINATION"))?;
            kernel
                .cold_live_aliases(
                    &retained,
                    &real,
                    &destination,
                    &host,
                    &container,
                    budget.end(runtime, 30),
                )
                .map_err(LaptopError::MemoryKernel)?;
        }
    }
    Ok(())
}
fn data(error: reverie_contracts::worker_cold_tmp::ColdDataError) -> LaptopError {
    LaptopError::ColdStorage(crate::worker_storage::StorageOwnerError::ColdData(error))
}
