use super::*;
use reverie_host::worker_storage::StorageOwnershipKind;
pub(super) enum Outcome {
    Fresh,
    Observed(Arc<StoppedRamObservation>),
    Failed(Arc<StoppedRamError>),
}
pub(super) struct Held {
    pub(super) owner: Box<LaunchStorage>,
    pub(super) context: ObservationContext,
    pub(super) outcome: Outcome,
}
pub(in crate::installing_broker::storage) struct Record {
    pub(super) held: Option<Held>,
}
impl Record {
    pub(super) fn held(&mut self) -> StopResult<&mut Held> {
        self.held
            .as_mut()
            .ok_or_else(|| refused("RAM_STOPPED_SOURCE_CONSUMED"))
    }
}
impl Held {
    pub(super) fn current(&self, runtime: &WorkerRuntime) -> StopResult<()> {
        self.context
            .assert_worker_runtime(runtime)
            .map_err(native)?;
        self.owner
            .assert_binding(
                runtime,
                self.context.configuration(),
                self.owner.paths().session(),
            )
            .map_err(storage)?;
        if self.owner.check_resource_current().map_err(storage)? != StorageOwnershipKind::HeldLease
        {
            return Err(refused("RAM_STOPPED_EMPLOYEE_LEASE_REQUIRED"));
        }
        Ok(())
    }
    fn read(&self, runtime: &WorkerRuntime) -> StopResult<Arc<StoppedRamObservation>> {
        let end = self.context.deadline(None).map_err(native)?;
        let body = (|| {
            self.current(runtime)?;
            let observed = self
                .context
                .observe_stopped_ram(self.owner.paths(), end)
                .map_err(native)?;
            self.current(runtime)?;
            Ok(Arc::new(observed))
        })();
        finalized(body, self.context.settle_stopped_ram(end).map_err(native))
    }
    pub(super) fn observe(
        &mut self,
        runtime: &WorkerRuntime,
    ) -> StopResult<Arc<StoppedRamObservation>> {
        match &self.outcome {
            Outcome::Fresh => {}
            Outcome::Observed(_) => return Err(refused("RAM_STOPPED_SOURCE_ALREADY_OBSERVED")),
            Outcome::Failed(error) => return Err(error.clone()),
        }
        let result = self.read(runtime);
        self.outcome = match &result {
            Ok(observed) => Outcome::Observed(observed.clone()),
            Err(error) => Outcome::Failed(error.clone()),
        };
        result
    }
    pub(super) fn recheck(&mut self, runtime: &WorkerRuntime) -> StopResult<()> {
        let original = match &self.outcome {
            Outcome::Observed(value) => value.clone(),
            Outcome::Fresh => return Err(refused("RAM_STOPPED_SOURCE_OBSERVATION_REQUIRED")),
            Outcome::Failed(error) => return Err(error.clone()),
        };
        let result = self
            .read(runtime)
            .and_then(|fresh| original.assert_same(&fresh).map_err(native));
        if let Err(error) = &result {
            self.outcome = Outcome::Failed(error.clone());
        }
        result
    }
    pub(super) fn primary(&self) -> Option<Arc<StoppedRamError>> {
        match &self.outcome {
            Outcome::Failed(error) => Some(error.clone()),
            _ => None,
        }
    }
}
impl Drop for Record {
    fn drop(&mut self) {
        if let Some(held) = self.held.take() {
            std::mem::forget(held);
        }
    }
}
