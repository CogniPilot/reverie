//! Authenticated read-only employee resources. Requested policy is not kernel
//! observation, and no status response permits a future mutation.
use super::*;
use reverie_contracts::{
    resource_config::ResourceIdentitySettings,
    storage_identity::{CurrentEmployee, Metadata, MetadataText},
    task_perf_v1::TaskPerfConfiguration,
    worker_pool::WorkerPoolProvider,
};
use reverie_store::storage_identity::{self, StorageIdentityConfig};
use sha2::{Digest, Sha256};

impl AuthenticatedResourceOperation<'_> {
    pub(in crate::installing_broker::resource_actor) fn employee_status_reply(
        &mut self,
    ) -> Result<HumanFrame> {
        let ResourceRequestSelection::EmployeeStatus {
            employee_id,
            session_id,
        } = self.request().selection()
        else {
            return Err(ResourceActorError::Refused(
                "EMPLOYEE_RESOURCE_STATUS_REQUIRED",
            ));
        };
        let (employee, session) = (employee_id.clone(), session_id.clone());
        self.assert_current()?;
        let owner = self.current_owner()?.owner().clone();
        let value = observe(&mut self.website.frame, &employee, &session, &owner)?;
        self.assert_current()?;
        let raw = serde_json::to_vec(&serde_json::json!({
            "kind":"resource-result","requestId":self.request().request_id().as_str(),"value":value,
        }))
        .map_err(|_| ResourceActorError::Refused("EMPLOYEE_RESOURCE_ENCODING"))?;
        HumanFrame::decode(&raw).map_err(Into::into)
    }
}
fn observe(
    frame: &mut Frame<'_>,
    employee: &reverie_core::ids::ProfileEmployeeId,
    session: &reverie_core::ids::ProfileSessionId,
    owner: &Option<reverie_core::PythonText>,
) -> Result<serde_json::Value> {
    let end = frame.deadline;
    let before = read_company(frame)?;
    let current = before
        .current_employee(
            employee,
            session,
            &owner
                .as_ref()
                .map(|value| MetadataText::from_python_text(value.clone())),
        )?
        .ok_or(ResourceActorError::Refused(
            "EMPLOYEE_RESOURCE_CURRENT_SESSION",
        ))?;
    let snapshot = Arc::clone(frame.snapshot.as_ref().expect("actual bound configuration"));
    let provider = WorkerPoolProvider::from_config(snapshot.configuration())
        .map_err(|_| ResourceActorError::Refused("EMPLOYEE_RESOURCE_PROVIDER"))?;
    let inventory_result = frame
        .context
        .as_ref()
        .expect("original native context")
        .custody(Some(end))
        .map_err(ResourceActorError::from);
    let inventory = frame.retain_stateless_result(inventory_result)?;
    let row = inventory
        .employee_selected(snapshot.configuration(), &current)
        .map_err(|_| ResourceActorError::Refused("EMPLOYEE_RESOURCE_CONTAINER_BINDING"))?;
    let (state, observed) = observe_member(frame, provider.as_ref(), row.as_ref(), &current, end)?;
    let requested = requested_policy(snapshot.configuration(), provider.as_ref(), employee)?;
    assert_after(frame, &before, &current, &inventory, end)?;
    let domain = reverie_contracts::reservation_control::domain_digest(snapshot.configuration())
        .map_err(|_| ResourceActorError::Refused("EMPLOYEE_RESOURCE_DOMAIN"))?
        .to_hex();
    let revision_bytes = serde_json::to_vec(&(
        domain,
        before.company_snapshot_digest()?,
        employee.as_str(),
        session.as_str(),
        &requested,
    ))
    .map_err(|_| ResourceActorError::Refused("EMPLOYEE_RESOURCE_ENCODING"))?;
    let revision = Sha256::digest(revision_bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    Ok(serde_json::json!({
        "version":1,"employeeId":employee.as_str(),"sessionId":session.as_str(),
        "revision":revision,"state":state,"requested":requested,"observed":observed,
        "perfObserved":null,"perfObservationReason":"OWN_PROCESS_PROBE_REQUIRED",
        "capabilities":{"softMemoryLive":false,"cpuWeightLive":false,"hardMemoryReplacement":false,
            "perfReplacement":false,"gpuReplacement":false},
        "readOnly":true,
    }))
}
fn observe_member(
    frame: &mut Frame<'_>,
    provider: Option<&WorkerPoolProvider>,
    row: Option<&crate::reservation_observer::ObservedRow<'_>>,
    current: &CurrentEmployee,
    end: Instant,
) -> Result<(
    &'static str,
    Option<reverie_host::worker_pool::EmployeeResourceObservation>,
)> {
    let mut observed = None;
    let mut state = "uninstalled";
    if let Some(provider) = provider {
        let policy = provider.policy();
        state = match row {
            None => "absent",
            Some(row) if !row.data().running().map_err(GateError::from)? => "stopped",
            Some(row) => {
                let broker = frame.broker;
                let mut slot = broker.controller.try_lock().map_err(|_| {
                    ResourceActorError::Refused("WORKER_CONTROLLER_SLOT_UNAVAILABLE")
                })?;
                if let Some(controller) = slot.as_mut() {
                    need(
                        controller.policy_data() == policy,
                        "EMPLOYEE_RESOURCE_POLICY_CHANGED",
                    )?;
                    let query = frame
                        .context
                        .as_ref()
                        .expect("same Q native context")
                        .metadata_query_owner()?;
                    let native = controller
                        .observe_employee_resources(
                            &frame.broker.storage.runtime,
                            query,
                            &mut frame.processes,
                            current,
                            row.data().id(),
                            end,
                        )
                        .map_err(|cause| ResourceActorError::Controller(Box::new(cause)));
                    drop(slot);
                    observed = Some(frame.retain_stateless_result(native)?);
                    "running"
                } else {
                    "controller-unavailable"
                }
            }
        };
    }
    Ok((state, observed))
}
fn requested_policy(
    config: &reverie_contracts::worker_config::EffectiveWorkerConfig,
    provider: Option<&WorkerPoolProvider>,
    employee: &reverie_core::ids::ProfileEmployeeId,
) -> Result<Option<serde_json::Value>> {
    if let Some(provider) = provider {
        let policy = provider.policy();
        let perf = TaskPerfConfiguration::validate(config)
            .map_err(|_| ResourceActorError::Refused("EMPLOYEE_RESOURCE_PERF_POLICY"))?
            .selected(Some(employee))
            .map_or("off", |policy| policy.name());
        Ok(Some(serde_json::json!({
            "memoryHighMiB": policy.employee_memory_high_mi_b.get(employee.as_str()),
            "memoryMaxMiB": policy.memory_max_mi_b,
            "cpuWeight": policy.cpu_weight,
            "allowedCpus": policy.allowed_cpus,
            "perfPolicy": perf,
        })))
    } else {
        Ok(None)
    }
}
fn assert_after(
    frame: &mut Frame<'_>,
    before: &Metadata,
    current: &CurrentEmployee,
    inventory: &crate::reservation_observer::ObservedInventory,
    end: Instant,
) -> Result<()> {
    frame.guard_bootstrap(end)?;
    let after = read_company(frame)?;
    need(
        before.company_snapshot_digest()? == after.company_snapshot_digest()?,
        "EMPLOYEE_RESOURCE_COMPANY_CHANGED",
    )?;
    assert_current_binding(&after, current)?;
    let after_inventory_result = frame
        .context
        .as_ref()
        .expect("original native context")
        .custody(Some(end))
        .map_err(ResourceActorError::from);
    let after_inventory = frame.retain_stateless_result(after_inventory_result)?;
    need(
        inventory.equivalent(&after_inventory),
        "EMPLOYEE_RESOURCE_INVENTORY_CHANGED",
    )?;
    Ok(())
}
fn read_company(frame: &mut Frame<'_>) -> Result<Metadata> {
    let settings = ResourceIdentitySettings::capture_worker_config(
        frame
            .snapshot
            .as_ref()
            .expect("bound snapshot")
            .configuration(),
    )
    .map_err(GateError::from)?;
    let identity = StorageIdentityConfig::capture_worker_settings(&settings);
    let read = storage_identity::read_company_metadata(&identity)
        .map_err(GateError::from)
        .map_err(Into::into);
    frame.retain_stateless_result(read)
}
fn assert_current_binding(company: &Metadata, original: &CurrentEmployee) -> Result<()> {
    need(
        company
            .current_employee(original.identity(), original.session(), original.owner())?
            .as_ref()
            == Some(original),
        "EMPLOYEE_RESOURCE_CURRENT_SESSION",
    )
}
