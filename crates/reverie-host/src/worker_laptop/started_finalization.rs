//! A failed later-J prefix retains the actual Created record. A fresh LIVE
//! observation can finish only this handler; stopped DATA cannot release it.
use super::*;
use crate::{captured_client::CapturedCall, worker_reports::WorkerLaunchConnection};

#[must_use = "retain the original Started record and any unresolved native read"]
pub struct StartedStorageFinalizer {
    workflow: LaptopWorkflow,
    plan: Option<ObservedCreatePlan>,
    previous: Phase,
    connection: crate::worker_reports::terminal::RelayIdentity,
    pending: Option<CapturedCall>,
    observation: Observation,
}
enum Observation {
    Unattempted,
    Reading,
    Known { current: Arc<()>, live: bool },
    Failed(Arc<LaptopError>),
}
impl WorkerRuntime {
    /// Refusal precedes changes and leaves the caller's plan untouched. The
    /// same original record fences every forward purpose during this finally.
    pub fn retain_started_final_storage(
        &self,
        created: &CreatedLaptop,
        plan: &mut Option<ObservedCreatePlan>,
        connection: &WorkerLaunchConnection,
    ) -> Result<StartedStorageFinalizer> {
        let mut record = self
            .laptop_workflows()
            .started_storage_record(self, created)?;
        let resources = record.resources();
        let plan_ref = plan
            .as_ref()
            .ok_or(LaptopError::Refused("WORKER_STARTED_PLAN_REQUIRED"))?;
        plan_ref
            .assert_storage_owner(self, resources.storage())
            .map_err(LaptopError::Plan)?;
        let next = connection
            .viewer_constructor_identity(self, resources.plan.session())
            .map_err(LaptopError::Refused)?;
        resources
            .connection
            .as_ref()
            .ok_or(LaptopError::Refused("WORKER_STARTED_CONNECTION_REQUIRED"))?
            .require_released_predecessor(&next)
            .map_err(LaptopError::Refused)?;
        storage::require_local_closed(self, &record)?;
        need(
            record.source_attachment.is_none(),
            "WORKER_STARTED_SOURCE_ATTACHED",
        )?;
        let previous = record.phase;
        record.phase = Phase::FinalizingStarted;
        Ok(StartedStorageFinalizer {
            workflow: created.workflow.clone(),
            plan: plan.take(),
            previous,
            connection: next,
            pending: None,
            observation: Observation::Unattempted,
        })
    }
}
impl StartedStorageFinalizer {
    pub fn observe(&mut self, runtime: &WorkerRuntime) -> Result<DirectStorageObservation> {
        runtime.laptop_workflows().bound(runtime, &self.workflow)?;
        let record = self
            .workflow
            .record
            .try_lock()
            .map_err(|_| LaptopError::Refused("WORKER_LAPTOP_RETAINED"))?;
        need(
            record.phase == Phase::FinalizingStarted,
            "WORKER_STARTED_FINAL_STORAGE_CHANGED",
        )?;
        need(
            matches!(self.observation, Observation::Unattempted),
            "WORKER_STARTED_FINAL_ALREADY_OBSERVED",
        )?;
        self.observation = Observation::Reading;
        let resources = record.resources();
        let original = record
            .creation
            .as_ref()
            .and_then(|creation| creation.container.as_ref())
            .ok_or(LaptopError::Refused(
                "WORKER_LAPTOP_CREATED_CID_RECONCILIATION_REQUIRED",
            ))?;
        let result = final_storage::observe(
            runtime,
            &mut self.pending,
            resources.storage(),
            self.plan.as_ref().expect("same original plan"),
            Some(original),
        );
        match result {
            Ok(live) => {
                let current = Arc::new(());
                self.observation = Observation::Known {
                    current: current.clone(),
                    live,
                };
                Ok(DirectStorageObservation::recorded(
                    resources.storage().owner_identity().clone(),
                    current,
                    live,
                ))
            }
            Err(cause) => {
                let cause = Arc::new(cause);
                self.observation = Observation::Failed(cause.clone());
                Err(LaptopError::Recorded(cause))
            }
        }
    }
    /// Keeps the same physical storage and Office. A negative/uncertain read
    /// needs the owning stop/reconciliation path; it never fabricates Stopped.
    pub fn finish_live(
        &mut self,
        runtime: &WorkerRuntime,
        observation: &DirectStorageObservation,
    ) -> Result<ObservedCreatePlan> {
        runtime.laptop_workflows().bound(runtime, &self.workflow)?;
        let mut record = self
            .workflow
            .record
            .try_lock()
            .map_err(|_| LaptopError::Refused("WORKER_LAPTOP_RETAINED"))?;
        need(
            record.phase == Phase::FinalizingStarted,
            "WORKER_STARTED_FINAL_STORAGE_CHANGED",
        )?;
        if let Observation::Failed(cause) = &self.observation {
            return Err(LaptopError::Recorded(cause.clone()));
        }
        let resources = record.resources();
        let known = matches!(&self.observation, Observation::Known {current, live: true}
            if observation.is_live() && observation.matches(resources.storage().owner_identity(), current));
        need(
            known && self.pending.is_none(),
            "WORKER_STARTED_FINAL_STORAGE_RETAINED",
        )?;
        let plan = self.plan.as_ref().ok_or(LaptopError::Refused(
            "WORKER_STARTED_FINAL_STORAGE_CONSUMED",
        ))?;
        plan.assert_storage_owner(runtime, resources.storage())
            .map_err(LaptopError::Plan)?;
        resources
            .storage()
            .check_resource_current()
            .map_err(LaptopError::StorageOwner)?;
        storage::require_local_closed(runtime, &record)?;
        // Publication is infallible after the last native/currentness check.
        // A subsequent J must await this actual handler's physical/logical end.
        record
            .resources
            .as_mut()
            .expect("same original resources")
            .connection = Some(self.connection.clone());
        record.phase = self.previous;
        Ok(self.plan.take().expect("checked original plan"))
    }
}
impl Drop for StartedStorageFinalizer {
    fn drop(&mut self) {
        if self.plan.is_some() {
            // The counted Created record remains fenced. Preserve the actual
            // unresolved call and observation instead of treating Drop as close.
            std::mem::forget(self.plan.take());
            std::mem::forget(self.pending.take());
            std::mem::forget(std::mem::replace(
                &mut self.observation,
                Observation::Reading,
            ));
        }
    }
}
