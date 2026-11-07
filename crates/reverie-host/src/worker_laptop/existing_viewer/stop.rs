//! Same bounded existing record: stop must precede viewer reap. Local query or
//! viewer settlement never clears an attempted unknown provider stop.
use super::*;
use crate::worker_source_stop::legacy::OrdinaryStopAttempt;

#[derive(Default)]
pub(super) struct ExistingStop {
    attempt: Option<OrdinaryStopAttempt>,
}
impl ExistingStop {
    pub(super) fn require_startable(&self) -> Result<()> {
        need(
            self.attempt.is_none(),
            "WORKER_EXISTING_STOP_ALREADY_ATTEMPTED",
        )
    }
    pub(super) fn require_reclaimable(&self) -> Result<()> {
        need(
            self.attempt
                .as_ref()
                .is_none_or(OrdinaryStopAttempt::confirmed),
            "WORKER_EXISTING_STOP_UNCONFIRMED",
        )
    }
    pub(super) fn settle(&mut self, runtime: &WorkerRuntime, end: Instant) -> Result<()> {
        if let Some(attempt) = &mut self.attempt {
            attempt
                .settle(runtime, end)
                .map_err(LaptopError::OrdinaryStop)?;
        }
        Ok(())
    }
}
impl WorkerRuntime {
    /// The actual App first checks its common stop admission and final receipt.
    /// This retains the SAME Box, plan, inspection and optional real viewer job
    /// throughout native work. Held/no-constructor also covers original finally.
    pub fn stop_existing_viewer_laptop(
        &self,
        existing: &ExistingViewer,
        end: Instant,
    ) -> Result<()> {
        self.stop_existing_laptop_body(existing, Some(end))
    }
    /// Genuine broker finally policy: no aggregate body cap. Every fixed
    /// client call keeps 20 seconds and the actual original first-stop bound.
    pub fn stop_existing_viewer_laptop_for_worker(&self, existing: &ExistingViewer) -> Result<()> {
        self.stop_existing_laptop_body(existing, None)
    }
    fn stop_existing_laptop_body(
        &self,
        existing: &ExistingViewer,
        end: Option<Instant>,
    ) -> Result<()> {
        self.laptop_workflows()
            .bound_existing(self, &existing.reference)?;
        let mut record = existing
            .reference
            .record
            .try_lock()
            .map_err(|_| LaptopError::Refused("WORKER_EXISTING_VIEWER_RETAINED"))?;
        need(
            matches!(record.stage, Stage::Held | Stage::Viewing | Stage::Retained),
            "WORKER_EXISTING_STOP_AFTER_REAP",
        )?;
        need(
            record.stop.attempt.is_none(),
            "WORKER_ORDINARY_STOP_ALREADY_ATTEMPTED",
        )?;
        let inputs = record.inputs.as_ref().expect("same retained actual inputs");
        let attempt = OrdinaryStopAttempt::new(
            self,
            &inputs.storage,
            &inputs.plan,
            Some(&inputs.inspected),
            end,
        )
        .map_err(LaptopError::OrdinaryStop)?;
        record.stop.attempt = Some(attempt);
        let result = record
            .stop
            .attempt
            .as_mut()
            .expect("latched same-record attempt")
            .run(self)
            .map_err(LaptopError::OrdinaryStop);
        if let Err(error) = result {
            let error = Arc::new(error);
            // Constructor failure remains its original cause; the actual stop
            // attempt independently owns its complete new typed failure.
            if record.failure.is_none() {
                record.failure = Some(error.clone());
            }
            return Err(LaptopError::Recorded(error));
        }
        Ok(())
    }
}
