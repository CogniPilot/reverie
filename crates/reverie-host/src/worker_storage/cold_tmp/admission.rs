//! Fixed complete Broker cold census on the actual Runtime capture. No caller
//! callback, selected command or serialized admission permit exists here.
mod mounts;
use super::*;
use crate::{
    captured_client::{CancellationToken, CapturedCall, Policy},
    engine_metadata::EngineError,
    reservation_kernel::ReservationKernel,
    worker_launch::ObservedCreatePlan,
    worker_runtime::WorkerRuntime,
};
use reverie_contracts::{
    resource_config::ResourceIdentitySettings,
    worker_cold_tmp::{ColdConfiguration, ColdInventory, ColdInventoryIds, ColdStrategy},
};
use std::{ffi::OsString, time::Duration};
type OwnerResult<T> = std::result::Result<T, super::super::StorageOwnerError>;
use super::super::{LaunchStorage, StorageOwnerError, StorageOwnershipKind};
#[derive(Default)]
pub(in crate::worker_storage) struct Admission {
    pending: Option<CapturedCall>,
}
impl Admission {
    pub(super) fn settle(
        &mut self,
        engine: &crate::installed_worker_engine::InstalledWorkerEngine,
        end: Instant,
    ) -> OwnerResult<()> {
        if let Some(call) = &self.pending {
            engine
                .readonly()
                .client
                .settle_call(call, end)
                .map_err(EngineError::from)
                .map_err(StorageOwnerError::Engine)?;
            self.pending = None;
        }
        Ok(())
    }
    pub(in crate::worker_storage) fn observe(
        &mut self,
        runtime: &WorkerRuntime,
        storage: &LaunchStorage,
        plan: &ObservedCreatePlan,
        keys: &BTreeSet<Key>,
        end: Instant,
    ) -> OwnerResult<()> {
        self.current(runtime, storage, plan, end)?;
        let source = plan.source();
        let config = Configuration::capture(source).map_err(StorageOwnerError::Storage)?;
        let paths = storage.paths();
        let original = super::super::temporary::path_text(&config, paths)
            .map_err(StorageOwnerError::Storage)?;
        let policy = ColdConfiguration::capture(source)
            .map_err(StorageOwnerError::ColdData)?
            .ok_or(StorageOwnerError::Refused("WORKER_COLD_POLICY_REQUIRED"))?;
        let listed = self.list(runtime, end)?;
        let rows = self.inspect(runtime, &listed, end)?;
        let mounts = mounts::CensusMounts::capture(&config, &original, paths, &policy, keys, end)?;
        mounts.declared(&policy)?;
        let name = format!(
            "/{}-agent-{}",
            runtime.worker_identity().deployment(),
            paths.session()
        );
        mounts.rows(&rows, &name)?;
        let verified = self.inspect(runtime, &listed, end)?;
        let after = self.list(runtime, end)?;
        require(
            listed.same_set(&after)
                && rows
                    .same_projection(&verified)
                    .map_err(StorageOwnerError::ColdData)?,
            "WORKER_COLD_NATIVE_CHANGED",
        )?;
        self.current(runtime, storage, plan, end)
    }
    fn current(
        &self,
        runtime: &WorkerRuntime,
        storage: &LaunchStorage,
        plan: &ObservedCreatePlan,
        end: Instant,
    ) -> OwnerResult<()> {
        require(self.pending.is_none(), "WORKER_COLD_CLIENT_RETAINED")?;
        require(
            Instant::now() < end && !runtime.cancellation().is_cancelled(),
            "WORKER_COLD_STOPPED_OR_EXPIRED",
        )?;
        plan.assert_storage_owner(runtime, storage)
            .map_err(|_| StorageOwnerError::Refused("WORKER_COLD_STORAGE_OWNER_CHANGED"))?;
        let settings = ResourceIdentitySettings::capture_worker_config(plan.source())
            .map_err(StorageOwnerError::Settings)?;
        let identity = StorageIdentityConfig::capture_worker_settings(&settings);
        require(
            storage_identity::storage_paths(&identity, storage.paths().session())
                .map_err(StorageOwnerError::Identity)?
                == *storage.paths(),
            "WORKER_COLD_STORAGE_BINDING_CHANGED",
        )?;
        require(
            storage_identity::storage_start_allowed(&identity, storage.paths())
                .map_err(StorageOwnerError::Identity)?,
            "WORKER_COLD_RUNNING_INTENT_CHANGED",
        )?;
        require(
            storage.check_resource_current()? == StorageOwnershipKind::HeldLease,
            "WORKER_COLD_EMPLOYEE_LEASE_REQUIRED",
        )
    }
    fn list(&mut self, runtime: &WorkerRuntime, end: Instant) -> OwnerResult<ColdInventoryIds> {
        let raw = self.query(
            runtime,
            ["ps", "--all", "--quiet", "--no-trunc"]
                .map(OsString::from)
                .to_vec(),
            end,
        )?;
        ColdInventoryIds::decode(&raw).map_err(StorageOwnerError::ColdData)
    }
    fn inspect(
        &mut self,
        runtime: &WorkerRuntime,
        ids: &ColdInventoryIds,
        end: Instant,
    ) -> OwnerResult<ColdInventory> {
        let raw = if ids.values().is_empty() {
            b"[]".to_vec()
        } else {
            let mut args = vec![OsString::from("inspect")];
            args.extend(ids.values().iter().map(|id| OsString::from(id.as_str())));
            self.query(runtime, args, end)?
        };
        ColdInventory::decode(&raw, ids).map_err(StorageOwnerError::ColdData)
    }
    fn query(
        &mut self,
        runtime: &WorkerRuntime,
        args: Vec<OsString>,
        end: Instant,
    ) -> OwnerResult<Vec<u8>> {
        require(self.pending.is_none(), "WORKER_COLD_CLIENT_RETAINED")?;
        let end = runtime.stop_deadline().map_or(end, |stop| stop.min(end));
        match runtime.installed_engine().readonly().client.run_scoped(
            args,
            end,
            &CancellationToken::new(),
            Policy {
                maximum: Duration::from_secs(20),
                maximum_output: 4 * 1024 * 1024,
                successful_exit: true,
            },
        ) {
            Ok(output) => Ok(output.stdout),
            Err(failure) => {
                if failure.error.is_uncertain() {
                    self.pending = failure.call;
                }
                Err(StorageOwnerError::Engine(EngineError::from(failure.error)))
            }
        }
    }
}
fn require(ok: bool, code: &'static str) -> OwnerResult<()> {
    if ok {
        Ok(())
    } else {
        Err(StorageOwnerError::Refused(code))
    }
}
