//! The real website operation can observe or queue its selected employee. It
//! cannot apply configuration, start a worker or bypass an installed consumer.
use super::*;
use crate::installing_broker::resource_actor::AuthenticatedResourceOperation;
use reverie_contracts::{resource_actor::ResourceRequestSelection, storage_identity::MetadataText};
use reverie_host::worker_runtime::WorkerRuntime;

pub(super) struct WebsiteGpu<'a, 'q> {
    operation: &'a AuthenticatedResourceOperation<'q>,
    session: &'a str,
}
impl WebsiteGpu<'_, '_> {
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
impl ReservationGate {
    pub(crate) fn gpu_website_command(
        &self,
        operation: &AuthenticatedResourceOperation<'_>,
        runtime: &WorkerRuntime,
    ) -> Result<GpuStatusData> {
        let bounds = operation
            .ram_admission_bounds(self)
            .map_err(|e| GateError::Refused(e.code()))?;
        let end = bounds
            .operation
            .expect("original Q deadline")
            .min(Instant::now() + Duration::from_secs(30));
        let request = operation.request();
        let employee = JournalId::parse(request.employee_id().as_str())?;
        let (session, intent) = match request.selection() {
            ResourceRequestSelection::GpuStatus { session_id, .. } => (session_id.as_str(), None),
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
