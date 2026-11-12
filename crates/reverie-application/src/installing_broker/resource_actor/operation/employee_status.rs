//! Authenticated read-only employee resources. Requested policy is not kernel
//! observation, and no status response permits a future mutation.
use super::*;
use reverie_contracts::{
    resource_config::ResourceIdentitySettings,
    storage_identity::{CurrentEmployee, Metadata, MetadataText},
    task_perf_v1::TaskPerfConfiguration,
    worker_pool::WorkerPoolProvider,
};
use reverie_core::ids::{ContainerId, ProfileEmployeeId, ProfileSessionId};
use reverie_host::worker_pool::EmployeeResourceObservation;
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
        let value =
            EmployeeResources::observe(&mut self.website.frame, &employee, &session, &owner)?
                .status(&employee, &session);
        self.assert_current()?;
        let raw = serde_json::to_vec(&serde_json::json!({
            "kind":"resource-result","requestId":self.request().request_id().as_str(),"value":value,
        }))
        .map_err(|_| ResourceActorError::Refused("EMPLOYEE_RESOURCE_ENCODING"))?;
        HumanFrame::decode(&raw).map_err(Into::into)
    }
}

pub(super) struct EmployeeResources {
    pub(super) snapshot: Arc<ValidatedWorkerSnapshot>,
    pub(super) current: CurrentEmployee,
    pub(super) provider: Option<WorkerPoolProvider>,
    pub(super) container: Option<ContainerId>,
    pub(super) observed: Option<EmployeeResourceObservation>,
    pub(super) revision: String,
    pub(super) live: bool,
    before: Metadata,
    inventory: crate::reservation_observer::ObservedInventory,
    requested: Option<serde_json::Value>,
    state: &'static str,
}

impl EmployeeResources {
    pub(super) fn observe(
        frame: &mut Frame<'_>,
        employee: &ProfileEmployeeId,
        session: &ProfileSessionId,
        owner: &Option<reverie_core::PythonText>,
    ) -> Result<Self> {
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
        let container = row.as_ref().map(|row| row.data().id().clone());
        let (state, observed, supported) =
            observe_member(frame, provider.as_ref(), row.as_ref(), &current, end)?;
        let live = supported && snapshot.source_path().is_some();
        let requested = requested_policy(snapshot.configuration(), provider.as_ref(), employee)?;
        assert_after(frame, &before, &current, &inventory, end)?;
        let domain =
            reverie_contracts::reservation_control::domain_digest(snapshot.configuration())
                .map_err(|_| ResourceActorError::Refused("EMPLOYEE_RESOURCE_DOMAIN"))?
                .to_hex();
        let running = observed.as_ref().map(|row| {
            (
                &row.container_id,
                row.pid,
                &row.process_start,
                &row.leaf_device,
                &row.leaf_inode,
                &row.memory_high_bytes,
                row.cpu_weight,
            )
        });
        let revision_bytes = serde_json::to_vec(&(
            domain,
            before.company_snapshot_digest()?,
            employee.as_str(),
            session.as_str(),
            &requested,
            running,
        ))
        .map_err(|_| ResourceActorError::Refused("EMPLOYEE_RESOURCE_ENCODING"))?;
        let revision = Sha256::digest(revision_bytes)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        Ok(Self {
            snapshot,
            current,
            provider,
            container,
            observed,
            revision,
            live,
            before,
            inventory,
            requested,
            state,
        })
    }

    fn status(
        &self,
        employee: &ProfileEmployeeId,
        session: &ProfileSessionId,
    ) -> serde_json::Value {
        serde_json::json!({
            "version":1,"employeeId":employee.as_str(),"sessionId":session.as_str(),
            "revision":self.revision,"state":self.state,"requested":self.requested,"observed":self.observed,
            "perfObserved":null,"perfObservationReason":"OWN_PROCESS_PROBE_REQUIRED",
            "capabilities":{"softMemoryLive":self.live,"cpuWeightLive":self.live,"hardMemoryReplacement":false,
                "perfReplacement":false,"gpuReplacement":false},
            "readOnly":true,
        })
    }

    pub(super) fn assert_current(&self, frame: &mut Frame<'_>, end: Instant) -> Result<()> {
        assert_after(frame, &self.before, &self.current, &self.inventory, end)
    }

    pub(super) fn assert_unique(&self) -> Result<()> {
        let selected = self.container.as_ref().ok_or(ResourceActorError::Refused(
            "EMPLOYEE_RESOURCE_CURRENT_CONTAINER",
        ))?;
        for row in self.inventory.rows() {
            let row = row.data();
            if row.id() != selected
                && row
                    .label_is("reverie.employee", self.current.identity().as_str())
                    .map_err(GateError::from)?
                && row.running().map_err(GateError::from)?
            {
                return Err(ResourceActorError::Refused(
                    "EMPLOYEE_RESOURCE_CONTAINER_AMBIGUOUS",
                ));
            }
        }
        Ok(())
    }
}
fn observe_member(
    frame: &mut Frame<'_>,
    provider: Option<&WorkerPoolProvider>,
    row: Option<&crate::reservation_observer::ObservedRow<'_>>,
    current: &CurrentEmployee,
    end: Instant,
) -> Result<(&'static str, Option<EmployeeResourceObservation>, bool)> {
    let mut observed = None;
    let mut live = false;
    let mut state = "uninstalled";
    if let Some(provider) = provider {
        state = match row {
            None => "absent",
            Some(row) if !row.data().running().map_err(GateError::from)? => "stopped",
            Some(row) => {
                let broker = frame.broker;
                let mut slot = broker.controller.try_lock().map_err(|_| {
                    ResourceActorError::Refused("WORKER_CONTROLLER_SLOT_UNAVAILABLE")
                })?;
                if let Some(controller) = slot.as_mut() {
                    controller
                        .assert_member_policy_provider(provider)
                        .map_err(|cause| ResourceActorError::Controller(Box::new(cause)))?;
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
                    live = controller.member_policy_edit_supported();
                    drop(slot);
                    observed = Some(frame.retain_stateless_result(native)?);
                    "running"
                } else {
                    "controller-unavailable"
                }
            }
        };
    }
    Ok((state, observed, live))
}
fn requested_policy(
    config: &reverie_contracts::worker_config::EffectiveWorkerConfig,
    provider: Option<&WorkerPoolProvider>,
    employee: &reverie_core::ids::ProfileEmployeeId,
) -> Result<Option<serde_json::Value>> {
    if let Some(provider) = provider {
        let policy = provider.policy();
        let member = provider.member_policy(employee.as_str());
        let perf = TaskPerfConfiguration::validate(config)
            .map_err(|_| ResourceActorError::Refused("EMPLOYEE_RESOURCE_PERF_POLICY"))?
            .selected(Some(employee))
            .map_or("off", |policy| policy.name());
        Ok(Some(serde_json::json!({
            "memoryHighMiB": member.map(|settings| settings.memory_high_mib()),
            "memoryMaxMiB": policy.memory_max_mi_b,
            "cpuWeight": member.map_or(policy.cpu_weight, |settings| settings.cpu_weight()),
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
pub(super) fn read_company(frame: &mut Frame<'_>) -> Result<Metadata> {
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
pub(super) fn assert_current_binding(company: &Metadata, original: &CurrentEmployee) -> Result<()> {
    need(
        company
            .current_employee(original.identity(), original.session(), original.owner())?
            .as_ref()
            == Some(original),
        "EMPLOYEE_RESOURCE_CURRENT_SESSION",
    )
}
