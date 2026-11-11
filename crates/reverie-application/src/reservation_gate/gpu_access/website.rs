//! Protected website GPU operations retain the original current owner.
use super::*;
use crate::installing_broker::resource_actor::{
    AuthenticatedResourceOperation, ResourceActorError,
};
use reverie_contracts::{resource_actor::ResourceRequestSelection, storage_identity::MetadataText};
use reverie_host::worker_runtime::{WorkerRuntime, WorkerStopBudget};

pub(super) struct WebsiteGpu<'a, 'q> {
    operation: &'a AuthenticatedResourceOperation<'q>,
    session: &'a str,
}
impl WebsiteGpu<'_, '_> {
    pub(super) fn observes_apply_readiness(&self) -> bool {
        matches!(
            self.operation.request().selection(),
            ResourceRequestSelection::GpuApplyStatus { .. }
        )
    }
    pub(super) fn require_current(
        website: Option<&Self>,
        gate: &ReservationGate,
        current: &GpuCurrentEmployee,
    ) -> Result<()> {
        let Some(website) = website else {
            return Ok(());
        };
        website
            .operation
            .assert_reservation_gate(gate)
            .map_err(|e| GateError::Refused(e.code()))?;
        let owner = website
            .operation
            .current_owner()
            .map_err(|e| GateError::Refused(e.code()))?;
        let owner = owner
            .owner()
            .as_ref()
            .map(|value| MetadataText::from_python_text(value.clone()));
        need(
            current.data().identity() == website.operation.request().employee_id()
                && current.data().session().as_str() == website.session
                && current.data().owner() == &owner,
            "GPU_CURRENT_SESSION_CHANGED",
        )
    }
}
pub(super) struct WebsiteGpuApply<'a, 'q> {
    pub(super) operation: &'a mut AuthenticatedResourceOperation<'q>,
    pub(super) stop: WorkerStopBudget,
    end: Instant,
    rebound_error: Option<ResourceActorError>,
}
impl WebsiteGpuApply<'_, '_> {
    pub(super) fn retain_rebound_error(&mut self, error: ResourceActorError) -> GateError {
        let code = error.code();
        self.rebound_error = Some(error);
        GateError::Refused(code)
    }
    pub(super) fn assert_budget(&self) -> Result<()> {
        let end = self
            .stop
            .deadline()
            .map_or(self.end, |stop| self.end.min(stop));
        need(Instant::now() < end, "GPU_APPLY_DEADLINE")
    }
    pub(super) fn require_current(
        &self,
        gate: &ReservationGate,
        current: &GpuCurrentEmployee,
    ) -> Result<()> {
        self.assert_budget()?;
        let ResourceRequestSelection::GpuApply { queued, .. } =
            self.operation.request().selection()
        else {
            return Err(GateError::Refused("GPU_WEBSITE_SELECTION_REQUIRED"));
        };
        let selected = WebsiteGpu {
            operation: self.operation,
            session: queued.session().as_str(),
        };
        WebsiteGpu::require_current(Some(&selected), gate, current)
    }
    pub(super) fn assert_live(&self, gate: &ReservationGate) -> Result<()> {
        self.assert_budget()?;
        self.operation
            .assert_reservation_gate(gate)
            .map_err(|error| GateError::Refused(error.code()))
    }
}
pub(super) fn stopped_target(
    row: Option<&crate::reservation_observer::ObservedRow<'_>>,
    context: &ObservationContext,
    end: Instant,
) -> Result<bool> {
    let Some(row) = row else { return Ok(true) };
    if row.data().running()? {
        return Ok(false);
    }
    let stopped = context.stopped_state(row, Some(end))?;
    Ok(stopped.permits_future_mount_source(row.data())?)
}
fn end(gate: &ReservationGate, operation: &AuthenticatedResourceOperation<'_>) -> Result<Instant> {
    let bounds = operation
        .ram_admission_bounds(gate)
        .map_err(|error| GateError::Refused(error.code()))?;
    Ok(bounds
        .operation
        .expect("original Q deadline")
        .min(Instant::now() + Duration::from_secs(30)))
}
impl ReservationGate {
    pub(crate) fn gpu_website_apply(
        &self,
        operation: &mut AuthenticatedResourceOperation<'_>,
        runtime: &WorkerRuntime,
    ) -> std::result::Result<(GpuStatusData, bool), ResourceActorError> {
        let end = end(self, operation)?;
        let ResourceRequestSelection::GpuApply {
            employee_id,
            queued,
        } = operation.request().selection()
        else {
            return Err(GateError::Refused("GPU_WEBSITE_SELECTION_REQUIRED").into());
        };
        let employee = JournalId::parse(employee_id.as_str()).map_err(GateError::from)?;
        let queued = queued.clone();
        let service = Service {
            gate: self,
            platform: platform::Installed {
                engine: runtime.readonly(),
                cancel: runtime.cancellation(),
            },
        };
        let mut website = WebsiteGpuApply {
            operation,
            stop: runtime.stop_budget(),
            end,
            rebound_error: None,
        };
        if let Err(gate) = service.apply_selected(&employee, &queued, end, Some(&mut website)) {
            return Err(match website.rebound_error {
                Some(primary) => ResourceActorError::GateFinalization {
                    primary: Box::new(primary),
                    secondary: Box::new(gate.into()),
                },
                None => gate.into(),
            });
        }
        let website = WebsiteGpu {
            operation: website.operation,
            session: queued.session().as_str(),
        };
        let admission = self
            .inner
            .admit(Service::<platform::Installed>::bounds(end))?;
        Ok(admission.conclude(service.status_body(
            Employee::Checked(employee),
            end,
            Some(&website),
        ))?)
    }
    pub(crate) fn gpu_website_command(
        &self,
        operation: &AuthenticatedResourceOperation<'_>,
        runtime: &WorkerRuntime,
    ) -> Result<(GpuStatusData, bool)> {
        let end = end(self, operation)?;
        let request = operation.request();
        let employee = JournalId::parse(request.employee_id().as_str())?;
        let (session, intent) = match request.selection() {
            ResourceRequestSelection::GpuStatus { session_id, .. }
            | ResourceRequestSelection::GpuApplyStatus { session_id, .. } => {
                (session_id.as_str(), None)
            }
            ResourceRequestSelection::GpuRequest { intent, .. } => {
                (intent.expected().session().as_str(), Some(intent))
            }
            _ => return Err(GateError::Refused("GPU_WEBSITE_SELECTION_REQUIRED")),
        };
        let website = WebsiteGpu { operation, session };
        let service = Service {
            gate: self,
            platform: platform::Installed {
                engine: runtime.readonly(),
                cancel: runtime.cancellation(),
            },
        };
        service.source_required()?;
        let admission = self
            .inner
            .admit(Service::<platform::Installed>::bounds(end))?;
        let result = (|| {
            if let Some(intent) = intent {
                service.queue(Employee::Checked(employee.clone()), intent, Some(&website))?;
            }
            service.status_body(Employee::Checked(employee), end, Some(&website))
        })();
        admission.conclude(result)
    }
}
