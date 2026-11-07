//! The original ten-second storage wait, without retaining common admission.
use super::*;
use reverie_contracts::{storage_writers::LaunchWaitBinding, worker_config};
use std::{cell::Cell, time::Duration};

pub(super) struct WaitObservation {
    pub(super) generation: LaunchGeneration,
    snapshot: Arc<ValidatedWorkerSnapshot>,
    binding: Option<LaunchWaitBinding>,
    config: Vec<u8>,
    waited: Cell<bool>,
    end: Instant,
}
impl WaitObservation {
    pub(super) fn waited(&self) -> bool {
        self.waited.get()
    }
    pub(super) fn capture(owner: &PreparingWorkerLaunch<'_>) -> Result<Self, PreparationError> {
        let broker = owner.broker();
        let generation = broker.installed.capture_generation()?;
        let binding = broker.launch_wait_binding(owner.admitted.request().session())?;
        let snapshot = broker.configuration()?;
        let config = worker_config::encode_config(snapshot.configuration());
        Ok(Self {
            generation,
            snapshot,
            binding,
            config,
            waited: Cell::new(false),
            end: Instant::now() + Duration::from_secs(10),
        })
    }
    pub(super) fn check_if_waited(
        &self,
        owner: &PreparingWorkerLaunch<'_>,
        lifecycle: &LaptopLifecycle<'_>,
    ) -> Result<(), PreparationError> {
        if self.waited.get() {
            self.check(owner, lifecycle)?;
        }
        Ok(())
    }
    fn check(
        &self,
        owner: &PreparingWorkerLaunch<'_>,
        lifecycle: &LaptopLifecycle<'_>,
    ) -> Result<(), PreparationError> {
        // Source loads the actual file FIRST, even when a later generation,
        // cancellation or RAM comparison will refuse. Preserve that order.
        let disk = match self.snapshot.source_path() {
            Some(path) => Arc::new(crate::worker_validation::load_owner_config(path)?),
            None => owner.broker().configuration()?,
        };
        lifecycle.check_generation(&self.generation)?;
        let runtime = &owner.broker().storage.runtime;
        if runtime.cancellation().is_cancelled()
            || worker_config::encode_config(owner.broker().configuration()?.configuration())
                != self.config
            || worker_config::encode_config(disk.configuration()) != self.config
            || owner
                .broker()
                .launch_wait_binding(owner.admitted.request().session())?
                != self.binding
        {
            return Err(PreparationError::Refused(
                "Laptop launch changed while waiting for previous data",
            ));
        }
        Ok(())
    }
    fn before_retry(&self, owner: &PreparingWorkerLaunch<'_>) -> Result<(), PreparationError> {
        let lifecycle = owner.broker().installed.lifecycle()?;
        self.check(owner, &lifecycle)
    }
    fn deadline(&self) -> Result<(), PreparationError> {
        if Instant::now() >= self.end {
            return Err(PreparationError::Refused(
                "Previous employee laptop has not released its data",
            ));
        }
        Ok(())
    }
}
impl PreparingWorkerLaunch<'_> {
    pub(super) fn acquire_storage(
        &mut self,
        observed: &WaitObservation,
    ) -> Result<StorageClaim, PreparationError> {
        loop {
            self.assert_allowed()?;
            if observed.waited.get() {
                observed.before_retry(self)?;
            }
            match self
                .broker()
                .claim_storage(self.admitted.request().session())
            {
                Ok(storage) => return Ok(storage),
                Err(error) if error.wait_busy() => {}
                Err(error) => return Err(error.into()),
            }
            if let Some(admission) = self.admitted.admission.take() {
                admission.close()?;
            }
            #[cfg(test)]
            tests::storage_busy();
            observed.deadline()?;
            let end = Instant::now() + Duration::from_millis(100);
            while Instant::now() < end
                && !self.broker().storage.runtime.cancellation().is_cancelled()
            {
                std::thread::sleep(
                    end.saturating_duration_since(Instant::now())
                        .min(Duration::from_millis(2)),
                );
            }
            observed.deadline()?;
            observed.waited.set(true);
            observed.before_retry(self)?;
            self.admitted.admission = self
                .broker()
                .resource_reservations()?
                .map(|gate| {
                    gate.admit_ordinary_launch(
                        self.admitted.request().session(),
                        AdmissionBounds {
                            operation: None,
                            entry: Some(observed.end),
                        },
                    )
                })
                .transpose()?;
        }
    }
}
