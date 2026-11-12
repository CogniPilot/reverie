//! One authenticated live edit owns the original admission, controller attempt
//! and publication fence through the selected terminal outcome.
use super::{employee_status::EmployeeResources, *};
use crate::reservation_gate::{MemberPolicyAdmission, MemberPolicyEnd};
use reverie_contracts::worker_pool::WorkerPoolConfigurationTransition;
use reverie_core::ids::ProfileEmployeeId;
use reverie_host::{
    reservation_control::{AdmissionLock, MemberPolicyPending},
    resource_facts::{ActorRebindPlan, ActorRebound},
    worker_pool::{
        ActivatedController, MemberPolicyEditCommitted, MemberPolicyEditError,
        MemberPolicyEditSelection, MemberPolicyEditSettlement, MemberPolicyEditVerified,
        PreparedMemberPolicyEdit,
    },
};

struct PlannedEdit {
    selection: EmployeeResources,
    native: Arc<PreparedMemberPolicyEdit>,
    configuration: Arc<WorkerPoolConfigurationTransition>,
    after: Arc<ValidatedWorkerSnapshot>,
    actor: ActorRebindPlan,
}

impl AuthenticatedResourceOperation<'_> {
    pub(in crate::installing_broker::resource_actor) fn employee_policy_reply(
        &mut self,
    ) -> Result<HumanFrame> {
        let ResourceRequestSelection::EmployeePolicyEdit {
            employee_id,
            approval,
        } = self.request().selection()
        else {
            return Err(ResourceActorError::Refused(
                "EMPLOYEE_RESOURCE_APPROVAL_REQUIRED",
            ));
        };
        let (employee, approval) = (employee_id.clone(), approval.clone());
        self.assert_current()?;
        let broker = self.website.frame.broker;
        let gate = broker
            .resource_reservations()?
            .ok_or(ResourceActorError::Refused("RESOURCE_ACTOR_GATE_REQUIRED"))?;
        let owner = self.current_owner()?.clone();
        let admitted = gate.admit_member_policy(self).map_err(Into::into);
        let admission = self.website.frame.retain_stateless_result(admitted)?;
        self.edit_member(admission, &employee, &approval, &owner)?;
        self.assert_current()?;
        let raw = serde_json::to_vec(&serde_json::json!({
            "kind":"resource-result","requestId":self.request().request_id().as_str(),
            "value":{
                "version":1,"employeeId":employee.as_str(),"sessionId":approval.session().as_str(),
                "operationId":approval.operation().as_str(),"state":"applied",
                "memoryHighMiB":approval.requested().memory_high_mib(),
                "cpuWeight":approval.requested().cpu_weight()
            }
        }))
        .map_err(|_| ResourceActorError::Refused("EMPLOYEE_RESOURCE_ENCODING"))?;
        HumanFrame::decode(&raw).map_err(Into::into)
    }

    fn edit_member(
        &mut self,
        admission: MemberPolicyAdmission,
        employee: &ProfileEmployeeId,
        approval: &EmployeePolicyEdit,
        owner: &CurrentResourceOwner,
    ) -> Result<()> {
        let broker = self.website.frame.broker;
        let prepared = (|| {
            let lifecycle = broker
                .installed
                .member_policy_lifecycle(self.website.frame.deadline)?;
            let plan = self.prepare_member(&admission, employee, approval, owner)?;
            let pending = admission.establish(Arc::clone(&plan.configuration), &plan.native)?;
            Ok((lifecycle, plan, pending))
        })();
        let (lifecycle, plan, mut pending) = match prepared {
            Ok(prepared) => prepared,
            Err(error) => {
                let closed = admission.close_before_edit().map_err(Into::into);
                return self
                    .website
                    .frame
                    .retain_stateless_result(error::finalized(Err(error), closed));
            }
        };
        let retained_edit = Arc::clone(&plan.native);
        let result = self.commit_member(&admission, &lifecycle, plan, &mut pending);
        let result = match result {
            Ok(terminal) => {
                let rejected = matches!(terminal, MemberPolicyEnd::Rejected(_));
                admission
                    .finish(pending, retained_edit, terminal)
                    .map_err(Into::into)
                    .and_then(|()| need(!rejected, "EMPLOYEE_RESOURCE_EDIT_REFUSED"))
            }
            Err(cause) => {
                let retained = admission.retain(pending, retained_edit).map_err(Into::into);
                error::finalized(Err(cause), retained)
            }
        };
        drop(lifecycle);
        self.website.frame.retain_stateless_result(result)
    }

    fn prepare_member(
        &mut self,
        admission: &MemberPolicyAdmission,
        employee: &ProfileEmployeeId,
        approval: &EmployeePolicyEdit,
        owner: &CurrentResourceOwner,
    ) -> Result<PlannedEdit> {
        let frame = &mut self.website.frame;
        let end = frame.deadline;
        let selection =
            EmployeeResources::observe(frame, employee, approval.session(), owner.owner())?;
        admission.assert_snapshot(&selection.snapshot)?;
        need(selection.live, "EMPLOYEE_RESOURCE_EDIT_UNAVAILABLE")?;
        need(
            selection.revision == approval.revision().as_str(),
            "EMPLOYEE_RESOURCE_REVISION_CHANGED",
        )?;
        selection.assert_unique()?;
        let provider = selection.provider.as_ref().expect("qualified live pool");
        let container = selection.container.as_ref().expect("qualified live member");
        let prior = provider
            .member_policy(employee.as_str())
            .expect("qualified live member");
        need(
            prior != approval.requested(),
            "EMPLOYEE_RESOURCE_POLICY_UNCHANGED",
        )?;
        let configuration = Arc::new(
            WorkerPoolConfigurationTransition::prepare_member_edit(
                selection.snapshot.configuration(),
                admission.binding(),
                employee.clone(),
                approval.requested(),
                provider.member_revision(),
            )
            .map_err(|_| ResourceActorError::Refused("EMPLOYEE_RESOURCE_POLICY_INVALID"))?,
        );
        let after = Arc::new(
            selection
                .snapshot
                .validate_pool_candidate(&configuration)
                .map_err(GateError::from)?,
        );
        let native = prepare_native(frame, &selection, container, approval, end)?;
        let observed = selection.observed.as_ref().expect("qualified live member");
        need(
            native.pid() == observed.pid
                && native.process_start() == observed.process_start
                && native.leaf_identity().0.to_string() == observed.leaf_device
                && native.leaf_identity().1.to_string() == observed.leaf_inode,
            "EMPLOYEE_RESOURCE_REVISION_CHANGED",
        )?;
        self.assert_current()?;
        let frame = &mut self.website.frame;
        selection.assert_current(frame, end)?;
        let actor = frame
            .private
            .prepare_configuration_rebind(configuration.before(), configuration.after())?;
        Ok(PlannedEdit {
            selection,
            native: Arc::new(native),
            configuration,
            after,
            actor,
        })
    }

    fn commit_member(
        &mut self,
        admission: &MemberPolicyAdmission,
        lifecycle: &LaptopLifecycle<'_>,
        plan: PlannedEdit,
        pending: &mut MemberPolicyPending,
    ) -> Result<MemberPolicyEnd> {
        let PlannedEdit {
            selection,
            native,
            after,
            actor,
            ..
        } = plan;
        let source = selection
            .snapshot
            .source_path()
            .expect("qualified live policy source");
        let lock = admission.native_lock()?;
        pending
            .prepare_publication(source, actor, &lock)
            .map_err(GateError::from)?;
        let broker = self.website.frame.broker;
        let issued = self.assert_live().and_then(|()| {
            with_controller(broker, |controller| {
                let issued = controller.issue_member_policy_edit(&native, pending, &lock);
                settle_apply(controller, &native, issued)
            })
        });
        let verified = match issued {
            Ok(Ok(verified)) => verified,
            Ok(Err(MemberPolicyEditError::Rejected(rejected))) => {
                let cancellation = pending
                    .rejected(&native, &rejected, &lock)
                    .map_err(GateError::from)?;
                return Ok(MemberPolicyEnd::Rejected(cancellation));
            }
            Ok(Err(
                error
                @ (MemberPolicyEditError::BeforeEffect(_) | MemberPolicyEditError::Refused(_)),
            )) => {
                return cancel_unissued(pending, &native, &lock, member_error(error));
            }
            Ok(Err(error)) => return Err(member_error(error)),
            Err(cause) => return cancel_unissued(pending, &native, &lock, cause),
        };
        // The owner approved the whole edit before its first native write.
        // Finish that exact transaction if the browser disconnects while
        // publishing the already verified kernel settings.
        pending
            .publish(&native, &verified, &lock)
            .map_err(GateError::from)?;
        let actor = pending.actor_rebind().map_err(GateError::from)?;
        let frame = &mut self.website.frame;
        frame.assert_member_publication(&selection.snapshot, &after, actor, native.deadline())?;
        let committed = with_controller(broker, |controller| {
            let committed =
                controller.commit_member_policy_edit(&native, &verified, pending, &lock);
            settle_commit(controller, &native, committed)
        })?
        .map_err(member_error)?;
        let publication = pending
            .committed_publication(&native, &committed, &lock)
            .map_err(GateError::from)?;
        admission.publish(lifecycle, &after, &publication)?;
        frame.accept_member_configuration(&selection.snapshot, &after, actor)?;
        let terminal = pending
            .terminal(&native, &committed)
            .map_err(GateError::from)?;
        Ok(MemberPolicyEnd::Applied(terminal))
    }
}

fn cancel_unissued(
    pending: &MemberPolicyPending,
    edit: &PreparedMemberPolicyEdit,
    lock: &AdmissionLock,
    primary: ResourceActorError,
) -> Result<MemberPolicyEnd> {
    if primary.has_unconfirmed_close() {
        return Err(primary);
    }
    match pending.cancel_unissued(edit, lock) {
        Ok(receipt) => Ok(MemberPolicyEnd::Rejected(receipt)),
        Err(error) => Err(ResourceActorError::Finalization {
            primary: Box::new(primary),
            secondary: Box::new(GateError::from(error).into()),
        }),
    }
}

fn prepare_native(
    frame: &mut Frame<'_>,
    selected: &EmployeeResources,
    container: &reverie_core::ids::ContainerId,
    approval: &EmployeePolicyEdit,
    end: Instant,
) -> Result<PreparedMemberPolicyEdit> {
    let broker = frame.broker;
    let query = frame
        .context
        .as_ref()
        .expect("same native context")
        .metadata_query_owner()?;
    let result = with_controller(broker, |controller| {
        controller.prepare_member_policy_edit(
            &broker.storage.runtime,
            query,
            &mut frame.processes,
            MemberPolicyEditSelection {
                current: &selected.current,
                container,
                configuration: selected.snapshot.configuration(),
                proposed: approval.requested(),
                operation: approval.operation(),
            },
            end,
        )
    })?
    .map_err(|cause| ResourceActorError::Controller(Box::new(cause)));
    frame.retain_stateless_result(result)
}

fn with_controller<T>(
    broker: &InstallingBroker,
    call: impl FnOnce(&mut ActivatedController) -> T,
) -> Result<T> {
    let mut slot = broker
        .controller
        .try_lock()
        .map_err(|_| ResourceActorError::Refused("WORKER_CONTROLLER_SLOT_UNAVAILABLE"))?;
    let controller = slot.as_mut().ok_or(ResourceActorError::Refused(
        "EMPLOYEE_RESOURCE_EDIT_UNAVAILABLE",
    ))?;
    Ok(call(controller))
}

fn settle_apply(
    controller: &mut ActivatedController,
    edit: &PreparedMemberPolicyEdit,
    result: std::result::Result<MemberPolicyEditVerified, MemberPolicyEditError>,
) -> std::result::Result<MemberPolicyEditVerified, MemberPolicyEditError> {
    match result {
        Err(MemberPolicyEditError::Retained) => {
            match controller.settle_member_policy_edit(edit, edit.deadline())? {
                MemberPolicyEditSettlement::Verified(proof) => Ok(proof),
                MemberPolicyEditSettlement::Committed(_) => Err(MemberPolicyEditError::Retained),
            }
        }
        other => other,
    }
}

fn settle_commit(
    controller: &mut ActivatedController,
    edit: &PreparedMemberPolicyEdit,
    result: std::result::Result<MemberPolicyEditCommitted, MemberPolicyEditError>,
) -> std::result::Result<MemberPolicyEditCommitted, MemberPolicyEditError> {
    match result {
        Err(MemberPolicyEditError::Retained) => {
            match controller.settle_member_policy_edit(edit, edit.deadline())? {
                MemberPolicyEditSettlement::Committed(proof) => Ok(proof),
                MemberPolicyEditSettlement::Verified(_) => Err(MemberPolicyEditError::Retained),
            }
        }
        other => other,
    }
}

fn member_error(error: MemberPolicyEditError) -> ResourceActorError {
    match error {
        MemberPolicyEditError::Refused(cause) => ResourceActorError::Controller(Box::new(cause)),
        MemberPolicyEditError::BeforeEffect(cause)
        | MemberPolicyEditError::RetainedIntent(cause) => GateError::from(cause).into(),
        MemberPolicyEditError::Retained | MemberPolicyEditError::Rejected(_) => {
            ResourceActorError::Refused("EMPLOYEE_RESOURCE_RECONCILIATION_REQUIRED")
        }
    }
}

impl Frame<'_> {
    fn assert_member_publication(
        &self,
        before: &Arc<ValidatedWorkerSnapshot>,
        after: &Arc<ValidatedWorkerSnapshot>,
        actor: &ActorRebound,
        end: Instant,
    ) -> Result<()> {
        need(
            Arc::ptr_eq(self.assert_configuration_owner(end)?, before)
                && before.source_path() == after.source_path(),
            "EMPLOYEE_RESOURCE_CONFIGURATION_CHANGED",
        )?;
        self.private
            .assert_configuration_rebind(actor, after.configuration())?;
        Ok(())
    }

    fn accept_member_configuration(
        &mut self,
        before: &Arc<ValidatedWorkerSnapshot>,
        after: &Arc<ValidatedWorkerSnapshot>,
        actor: &ActorRebound,
    ) -> Result<()> {
        need(
            self.snapshot
                .as_ref()
                .is_some_and(|snapshot| Arc::ptr_eq(snapshot, before))
                && Arc::ptr_eq(after, &self.broker.configuration()?),
            "EMPLOYEE_RESOURCE_CONFIGURATION_CHANGED",
        )?;
        let context = self
            .context
            .as_ref()
            .expect("bound context")
            .with_applied_configuration(after.configuration().clone());
        let bindings = self.bindings.as_mut().expect("bound website");
        bindings.installed = self.private.accept_configuration_rebind(actor)?;
        ResourceActorSettings::capture(after.configuration())?
            .require_document(&bindings.installed)?;
        self.context = Some(context);
        self.snapshot = Some(Arc::clone(after));
        Ok(())
    }
}
