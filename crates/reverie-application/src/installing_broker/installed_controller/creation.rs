//! Borrow the original slot across prospective admission and member effects.
//! Neither a selected provider nor a copied capacity result constructs this.
use super::*;
use reverie_contracts::reservation_engine::NativeLimitBinding;
use reverie_contracts::worker_config::EffectiveWorkerConfig;
use reverie_core::ids::ProfileSessionId;
use reverie_host::{
    worker_launch::ObservedCreatePlan,
    worker_pool::{ControllerCapacity, PoolMemberCreation},
    worker_runtime::WorkerRuntime,
};
use std::sync::MutexGuard;
mod effects;

pub(in crate::installing_broker) struct InstalledControllerBorrow<'a> {
    slot: &'a InstalledControllerSlot,
    guard: MutexGuard<'a, Option<ActivatedController>>,
    runtime: &'a WorkerRuntime,
}

/// The private constructor joins actual slot custody and the Host's borrowed
/// create guarantee. The outer slot guard must outlive every member phase.
pub(crate) struct InstalledMemberCreation<'a> {
    slot: &'a InstalledControllerSlot,
    member: PoolMemberCreation<'a>,
    runtime: &'a WorkerRuntime,
}

impl InstallingBroker {
    pub(in crate::installing_broker) fn borrow_controller_for_creation(
        &self,
    ) -> Result<InstalledControllerBorrow<'_>, PoolError> {
        let guard = self
            .controller
            .try_lock()
            .map_err(|_| PoolError::Refused("WORKER_CONTROLLER_SLOT_UNAVAILABLE"))?;
        if guard.is_none() {
            return Err(PoolError::Refused("WORKER_CONTROLLER_NOT_INSTALLED"));
        }
        Ok(InstalledControllerBorrow {
            slot: &self.controller,
            guard,
            runtime: &self.storage.runtime,
        })
    }
}

impl InstalledControllerBorrow<'_> {
    pub(in crate::installing_broker) fn check_pool(
        &mut self,
        resources: &reverie_core::resources::ResourcePolicy,
        require_headroom: bool,
        end: Instant,
    ) -> Result<(), PoolError> {
        self.guard
            .as_mut()
            .ok_or(PoolError::Refused("WORKER_CONTROLLER_NOT_INSTALLED"))?
            .check_creation_pool(self.runtime, resources, require_headroom, end)
    }

    pub(in crate::installing_broker) fn prepare_workflow_member(
        &mut self,
        workflow: &reverie_host::worker_laptop::LaptopWorkflow,
        connection: &WorkerLaunchConnection,
        end: Instant,
    ) -> Result<InstalledMemberCreation<'_>, PoolError> {
        let member = self
            .guard
            .as_mut()
            .ok_or(PoolError::Refused("WORKER_CONTROLLER_NOT_INSTALLED"))?
            .prepare_workflow_member_creation(self.runtime, workflow, connection, end)?;
        Ok(InstalledMemberCreation {
            slot: self.slot,
            member,
            runtime: self.runtime,
        })
    }

    pub(in crate::installing_broker) fn prepare_member(
        &mut self,
        plan: &ObservedCreatePlan,
        end: Instant,
    ) -> Result<InstalledMemberCreation<'_>, PoolError> {
        let member = self
            .guard
            .as_mut()
            .ok_or(PoolError::Refused("WORKER_CONTROLLER_NOT_INSTALLED"))?
            .prepare_member_creation(self.runtime, plan, end)?;
        Ok(InstalledMemberCreation {
            slot: self.slot,
            member,
            runtime: self.runtime,
        })
    }
}

impl InstalledMemberCreation<'_> {
    pub(crate) fn runtime(&self) -> &WorkerRuntime {
        self.runtime
    }

    pub(crate) fn assert_slot(
        &self,
        slot: Option<&InstalledControllerSlot>,
    ) -> Result<(), PoolError> {
        if slot.is_some_and(|slot| Arc::ptr_eq(slot, self.slot)) {
            Ok(())
        } else {
            Err(PoolError::Refused("WORKER_POOL_CREATION_SLOT_CHANGED"))
        }
    }

    pub(crate) fn assert_configuration(
        &mut self,
        source: &EffectiveWorkerConfig,
        effective: &EffectiveWorkerConfig,
        session: &ProfileSessionId,
    ) -> Result<(), PoolError> {
        self.member
            .assert_configuration(self.runtime, source, effective, session)
    }

    pub(crate) fn observe_capacity(
        &mut self,
        website: &NativeLimitBinding,
        end: Instant,
    ) -> Result<ControllerCapacity<'_>, PoolError> {
        self.member.observe_capacity(website, end)
    }
}
