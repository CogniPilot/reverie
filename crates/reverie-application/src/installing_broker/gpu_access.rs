use super::*;
use reverie_contracts::gpu_access::GpuCommand;
use reverie_core::gpu_access::GpuStatusData;
use reverie_host::reservation_control::MemberPolicyPublication;
impl InstallingBroker {
    /// Typed internal C consumer. The actual transport must authenticate owner
    /// UID before dispatch; OfficeAPI never exposes these owner-local verbs.
    pub fn owner_gpu_control(&self, command: GpuCommand) -> Result<GpuStatusData, GateError> {
        self.gate
            .as_ref()
            .ok_or(GateError::Refused("GPU_OWNER_CONTROL_UNAVAILABLE"))?
            .gpu_command(command, &self.storage.runtime)
    }
    /// Canonical unprotected, non-attach J prefix only: AFTER image refresh and
    /// BEFORE ordinary admission/preparation. Ok is no laptop/start permission.
    pub fn gpu_cold_boundary(&self, session: &ProfileSessionId) -> Result<(), GateError> {
        let Some(gate) = &self.gate else {
            return Ok(());
        };
        gate.gpu_cold(session, &self.storage.runtime)
    }
}
impl InstalledWorker {
    pub(crate) fn publish_member_policy(
        &self,
        before: &Arc<ValidatedWorkerSnapshot>,
        after: &Arc<ValidatedWorkerSnapshot>,
        lifecycle: &LaptopLifecycle<'_>,
        context: &mut crate::reservation_observer::ObservationContext,
        slot: &RwLock<reverie_contracts::reservation_control::ControlBinding>,
        proof: &MemberPolicyPublication<'_>,
    ) -> Result<(), GateError> {
        if !lifecycle.belongs_to(self) {
            return Err(GateError::Refused("EMPLOYEE_RESOURCE_LIFECYCLE_CHANGED"));
        }
        let transition = proof.transition()?;
        let digest = reverie_contracts::worker_config::config_digest;
        if digest(before.configuration()) != digest(transition.before())
            || digest(after.configuration()) != digest(transition.after())
        {
            return Err(GateError::Refused(
                "EMPLOYEE_RESOURCE_CONFIGURATION_CHANGED",
            ));
        }
        self.publish_configuration_tuple(
            before,
            after,
            transition.after_binding(),
            context,
            slot,
            ControllerPublication::Member(proof),
        )
    }

    /// GPU retains its already admitted original operation end. Ordinary
    /// creation also takes admission before lifecycle; never reverse that
    /// ordering or renew a budget while contending with its real owner.
    pub(crate) fn gpu_lifecycle(
        &self,
        end: std::time::Instant,
    ) -> Result<LaptopLifecycle<'_>, GateError> {
        self.lifecycle_with_deadline(LifecycleDeadline::Gpu(end))
    }
    pub(crate) fn member_policy_lifecycle(
        &self,
        end: std::time::Instant,
    ) -> Result<LaptopLifecycle<'_>, GateError> {
        self.lifecycle_with_deadline(LifecycleDeadline::MemberPolicy(end))
    }
    pub(crate) fn pool_lifecycle(
        &self,
        proof: &crate::reservation_gate::PublishedPool,
    ) -> Result<LaptopLifecycle<'_>, GateError> {
        self.lifecycle_with_deadline(LifecycleDeadline::Pool(proof))
    }
    fn lifecycle_with_deadline(
        &self,
        deadline: LifecycleDeadline<'_>,
    ) -> Result<LaptopLifecycle<'_>, GateError> {
        loop {
            let end = deadline.current()?;
            let guard = match self.laptops.try_lock() {
                Ok(guard) => guard,
                Err(std::sync::TryLockError::Poisoned(_)) => {
                    return Err(GateError::Refused("WORKER_BROKER_LIFECYCLE_UNAVAILABLE"));
                }
                Err(std::sync::TryLockError::WouldBlock) => {
                    std::thread::sleep(
                        end.saturating_duration_since(std::time::Instant::now())
                            .min(std::time::Duration::from_millis(10)),
                    );
                    continue;
                }
            };
            deadline.current()?;
            return Ok(LaptopLifecycle { owner: self, guard });
        }
    }
    pub(crate) fn publish_gpu(
        &self,
        proof: crate::reservation_gate::PublishedGpu,
        lifecycle: &LaptopLifecycle<'_>,
        context: &mut crate::reservation_observer::ObservationContext,
        slot: &RwLock<reverie_contracts::reservation_control::ControlBinding>,
    ) -> Result<(), GateError> {
        if !lifecycle.belongs_to(self) {
            return Err(GateError::Refused("GPU_LIFECYCLE_CHANGED"));
        }
        let (before, after, binding) = proof.parts();
        self.publish_configuration_tuple(
            before,
            after,
            binding,
            context,
            slot,
            ControllerPublication::Gpu(&proof),
        )
    }
    pub(crate) fn publish_pool(
        &self,
        proof: &crate::reservation_gate::PublishedPool,
        lifecycle: &LaptopLifecycle<'_>,
        context: &mut crate::reservation_observer::ObservationContext,
        binding: &RwLock<reverie_contracts::reservation_control::ControlBinding>,
        controller_slot: &installed_controller::InstalledControllerSlot,
        controller: &mut Option<reverie_host::worker_pool::ActivatedController>,
    ) -> Result<(), GateError> {
        if !lifecycle.belongs_to(self) {
            return Err(GateError::Refused("POOL_LIFECYCLE_CHANGED"));
        }
        let (before, after, next_binding) = proof.parts();
        self.publish_configuration_tuple(
            before,
            after,
            next_binding,
            context,
            binding,
            ControllerPublication::Install {
                slot: controller_slot,
                owner: controller,
                proof,
            },
        )
    }
    fn publish_configuration_tuple(
        &self,
        before: &Arc<ValidatedWorkerSnapshot>,
        after: &Arc<ValidatedWorkerSnapshot>,
        binding: &reverie_contracts::reservation_control::ControlBinding,
        context: &mut crate::reservation_observer::ObservationContext,
        slot: &RwLock<reverie_contracts::reservation_control::ControlBinding>,
        controller: ControllerPublication<'_>,
    ) -> Result<(), GateError> {
        let mut current = self
            .current
            .write()
            .map_err(|_| GateError::Refused("WORKER_BROKER_CURRENT_UNAVAILABLE"))?;
        let mut bound = slot
            .write()
            .map_err(|_| GateError::Refused("RESERVATION_ADMISSION_UNAVAILABLE"))?;
        if !Arc::ptr_eq(&current.snapshot, before)
            || before.source_path() != after.source_path()
            || !reverie_contracts::worker_config::equivalent(
                context.configuration(),
                before.configuration(),
            )
        {
            return Err(GateError::Refused("GPU_CONFIG_CHANGED"));
        }
        let next_context = context.with_applied_configuration(after.configuration().clone());
        let next = CurrentInstalled::capture(Arc::clone(after));
        let next_binding = binding.clone();
        let mut install = match controller {
            ControllerPublication::Gpu(proof) => {
                proof.assert_live()?;
                None
            }
            ControllerPublication::Member(proof) => {
                proof.assert_current()?;
                None
            }
            ControllerPublication::Install { slot, owner, proof } => {
                let target = slot
                    .try_lock()
                    .map_err(|_| GateError::Refused("WORKER_CONTROLLER_SLOT_UNAVAILABLE"))?;
                if target.is_some() || owner.is_none() {
                    return Err(GateError::Refused("WORKER_CONTROLLER_INSTALL_CHANGED"));
                }
                Some((target, owner, proof))
            }
        };
        if let Some((_, _, proof)) = &install {
            proof.assert_live()?;
        }
        // All fallible preparation and the final original-budget check ended.
        // Every tuple lock stays held across configuration/controller writes.
        *context = next_context;
        *current = next;
        *bound = next_binding;
        if let Some((target, owner, _)) = &mut install {
            **target = owner.take();
        }
        Ok(())
    }
}
enum ControllerPublication<'a> {
    Gpu(&'a crate::reservation_gate::PublishedGpu),
    Member(&'a MemberPolicyPublication<'a>),
    Install {
        slot: &'a installed_controller::InstalledControllerSlot,
        owner: &'a mut Option<reverie_host::worker_pool::ActivatedController>,
        proof: &'a crate::reservation_gate::PublishedPool,
    },
}
enum LifecycleDeadline<'a> {
    Gpu(std::time::Instant),
    MemberPolicy(std::time::Instant),
    Pool(&'a crate::reservation_gate::PublishedPool),
}
impl LifecycleDeadline<'_> {
    fn current(&self) -> Result<std::time::Instant, GateError> {
        match self {
            Self::Gpu(end) => {
                if std::time::Instant::now() >= *end {
                    return Err(GateError::Refused("GPU_APPLY_DEADLINE"));
                }
                Ok(*end)
            }
            Self::MemberPolicy(end) => {
                if std::time::Instant::now() >= *end {
                    return Err(GateError::Refused("EMPLOYEE_RESOURCE_DEADLINE"));
                }
                Ok(*end)
            }
            Self::Pool(proof) => {
                proof.assert_live()?;
                Ok(proof.deadline())
            }
        }
    }
}
