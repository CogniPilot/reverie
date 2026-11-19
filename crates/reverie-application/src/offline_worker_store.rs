//! Plan and apply seed-only preparation for an existing offline employee's private Nix store.
mod apply;
mod engine;
use crate::worker_validation::{self, ValidatedWorkerSnapshot};
pub use apply::{ApplyError, apply};
use reverie_contracts::{
    worker_config,
    worker_nix::offline_qualification::{PlanFacts, ProfileInventory, SealedPlan, plan, plan_text},
    worker_schema::{WorkerEnvelope, WorkerPath},
};
use reverie_core::ids::{OfflineStoreOperationId, ProfileEmployeeId, ProfileSessionId};
use reverie_host::worker_nix::{
    offline_qualification::{self as observe, ControlPin, QualifiedTarget, Seat},
    offline_store_engine::Query,
};
use serde_json::value::RawValue;
use sha2::{Digest, Sha256};
use std::{
    fs, io,
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
type ReadEngine<'a> = &'a dyn Fn(&Path, Query) -> Result<Vec<u8>>;

struct Snapshot {
    config: Config,
    target: QualifiedTarget,
    seat: Seat,
    plan: SealedPlan,
    profiles: ProfileInventory,
    retained: Vec<String>,
}

/// The same read-only implementation supplies the operator's plan and each
/// apply-path recheck. Engine observations carry no mutation capability.
fn snapshot(
    config_path: &Path,
    target_path: &Path,
    employee: &ProfileEmployeeId,
    operation: &OfflineStoreOperationId,
    clock: impl Fn() -> f64,
    read_engine: ReadEngine<'_>,
) -> Result<Snapshot> {
    let config = Config::capture(config_path)?;
    let target = observe::inspect(target_path, clock())?;
    target.target.require_unexpired(clock())?;
    engine::validate(&config.worker, &target.target, &config.roots, read_engine)?;
    let config_pin = ControlPin {
        path: config_path,
        digest: &config.digest,
    };
    config_pin.verify_current()?;
    ControlPin {
        path: target_path,
        digest: &target.digest,
    }
    .verify_current()?;
    let company = reverie_store::storage_identity::read_metadata(
        &config.roots.company_file,
        config.worker.envelope().base().ids().uid(),
        reverie_store::storage_identity::DEFAULT_METADATA_LIMIT,
    )?;
    let binding = target
        .target
        .admit_cohort(&company, Some(employee))?
        .ok_or("employee is outside the admitted offline cohort")?;
    let session = ProfileSessionId::parse(binding.session())?;
    let seat = observe::inspect_seat(config_pin, &session, employee, false)?;
    let retained = engine::custody(
        &config,
        &target,
        &seat,
        [config_path, target_path],
        read_engine,
    )?;
    let profiles = observe::capture_profiles(seat.paths.home(), seat.paths.nix())?;
    let facts = plan_facts(
        &config,
        &target,
        binding.digest(),
        &seat,
        &profiles,
        &retained,
    )?;
    let plan = seal(
        &config.roots.state,
        &target,
        employee,
        &session,
        operation,
        &facts,
    )?;
    Ok(Snapshot {
        config,
        target,
        seat,
        plan,
        profiles,
        retained,
    })
}

struct Config {
    digest: String,
    worker: ValidatedWorkerSnapshot,
    roots: Roots,
}
impl Config {
    fn capture(path: &Path) -> Result<Self> {
        let raw = observe::config(path)?;
        let worker =
            worker_validation::validate_captured(worker_config::decode_offline_store(&raw)?)?;
        observe::require_owner_uid(worker.envelope().base().ids().uid())?;
        let roots = Roots::capture(worker.envelope())?;
        Ok(Self {
            digest: format!("sha256:{:x}", Sha256::digest(&raw)),
            worker,
            roots,
        })
    }
}

struct Roots {
    state: PathBuf,
    scratch: PathBuf,
    company_file: PathBuf,
    company: PathBuf,
    broker_socket: PathBuf,
    office_socket: PathBuf,
}
impl Roots {
    fn capture(worker: &WorkerEnvelope) -> Result<Self> {
        let path = |field| observe::path(worker.path(field));
        Ok(Self {
            state: path(WorkerPath::StateRoot)?,
            scratch: path(WorkerPath::ScratchRoot)?,
            company_file: path(WorkerPath::CompanyFile)?,
            company: path(WorkerPath::CompanyRoot)?,
            broker_socket: path(WorkerPath::Socket)?,
            office_socket: path(WorkerPath::ApiSocketRoot)?,
        })
    }

    fn storage_sources(&self) -> [PathBuf; 3] {
        [
            self.company.clone(),
            self.state.join("employees"),
            self.scratch.join("employees"),
        ]
    }

    fn audit_directory(&self) -> PathBuf {
        audit_directory(&self.state)
    }
}

fn plan_facts(
    config: &Config,
    target: &QualifiedTarget,
    employee_digest: &str,
    seat: &Seat,
    profiles: &ProfileInventory,
    stopped_container_ids: &[String],
) -> Result<Box<RawValue>> {
    let (model, cohort) = target.target.budget()?;
    let budget = observe::capacity(model, cohort, &config.roots.state, &config.roots.scratch)?;
    Ok(PlanFacts {
        config_digest: &config.digest,
        target_digest: &target.digest,
        employee_digest,
        home_identity: identity(fs::metadata(seat.paths.home())?),
        nix_identity: identity(fs::metadata(seat.paths.nix())?),
        lock_identity: identity(fs::symlink_metadata(seat.locks.lock())?),
        sid_lock_identity: identity(fs::symlink_metadata(&seat.session_lock)?),
        profiles: serde_json::from_slice(&profiles.bytes()?)?,
        budget,
        stopped_container_ids: stopped_container_ids.to_vec(),
        helper_args: seat.helper.arguments().iter().map(plan_text).collect(),
        helper_name: plan_text(seat.helper.name()),
    }
    .encode()?)
}

fn identity(meta: fs::Metadata) -> [u64; 4] {
    [
        meta.dev(),
        meta.ino(),
        u64::from(meta.uid()),
        u64::from(meta.mode() & 0o7777),
    ]
}

fn audit_directory(state: &Path) -> PathBuf {
    state.join("offline-store-maintenance")
}

fn seal(
    state: &Path,
    target: &QualifiedTarget,
    employee: &ProfileEmployeeId,
    session: &ProfileSessionId,
    operation: &OfflineStoreOperationId,
    facts: &RawValue,
) -> Result<SealedPlan> {
    let audit = audit_directory(state).join(format!("{}.json", operation.as_str()));
    match fs::symlink_metadata(&audit) {
        Ok(_) => return Err("operation already recorded; never retry it".into()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => (),
        Err(error) => return Err(error.into()),
    }
    Ok(plan(
        operation.as_str(),
        employee.as_str(),
        session.as_str(),
        target.target.image_id(),
        facts,
    )?)
}

/// Produce the standalone CLI plan with native local read-only engine access.
pub fn preview(
    config: &Path,
    target: &Path,
    employee: &ProfileEmployeeId,
    operation: &OfflineStoreOperationId,
) -> Result<Vec<u8>> {
    let snapshot = snapshot(
        config,
        target,
        employee,
        operation,
        apply::epoch,
        &reverie_host::worker_nix::offline_store_engine::read,
    )?;
    Ok(snapshot.plan.bytes().to_vec())
}
