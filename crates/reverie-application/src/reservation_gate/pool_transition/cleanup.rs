//! Only selected original J cleanup may cross this SAME durable denial fence.
//! Ordinary entry remains refused; this grants no launch or fence release.
use super::*;
use reverie_core::worker_laptop::WorkerContainerName;
use reverie_host::{
    worker_reports::{WorkerLaunchConnection, WorkerOriginalHandlersCleanupBinding},
    worker_runtime::WorkerRuntime,
};

#[derive(Clone)]
pub(in crate::reservation_gate) struct OriginalCleanupAdmission {
    record: Arc<TransitionRecord>,
    target: CleanupTarget,
}
#[derive(Clone)]
enum CleanupTarget {
    OriginalHandler(WorkerContainerName),
    LegacyFleet {
        base: reverie_core::worker_schema::WorkerBase,
        targets: Arc<Vec<WorkerContainerName>>,
    },
}
impl PoolTransitionFence {
    pub(crate) fn assert_gate(&self, gate: &ReservationGate) -> Result<()> {
        need(
            Arc::ptr_eq(&self.gate, &gate.inner),
            "POOL_TRANSITION_GATE_CHANGED",
        )
    }
    pub(crate) fn assert_selection(&self, selected: &PoolTransitionSelection) -> Result<()> {
        need(
            self.record.intent.selection() == selected,
            "POOL_TRANSITION_SELECTION_CHANGED",
        )
    }
    pub(crate) fn bind_original_cleanup(
        &mut self,
        binding: WorkerOriginalHandlersCleanupBinding,
    ) -> Result<()> {
        // The App first validates SAME Q/service/runtime and owner selection.
        // Original R is acquired only for this check and released before J joins.
        self.current()?;
        let mut slot = self
            .record
            .original_cleanup
            .lock()
            .map_err(|_| GateError::Refused("POOL_TRANSITION_REQUIRES_RECONCILIATION"))?;
        need(slot.is_none(), "POOL_TRANSITION_CLEANUP_ALREADY_BOUND")?;
        *slot = Some(binding);
        Ok(())
    }
    pub(crate) fn assert_cleanup_selection(
        &self,
        binding: &WorkerOriginalHandlersCleanupBinding,
    ) -> Result<()> {
        self.assert_handlers_outside_admission()?;
        self.current()?;
        self.assert_cleanup_provenance(binding)
    }
    pub(crate) fn assert_handlers_outside_admission(&self) -> Result<()> {
        need(
            !self
                .gate
                .state
                .lock()
                .map_err(|_| GateError::Refused("RESERVATION_ADMISSION_UNAVAILABLE"))?
                .active
                .as_ref()
                .is_some_and(|active| {
                    active.thread == std::thread::current().id()
                        && active.process == std::process::id()
                }),
            "POOL_TRANSITION_HANDLER_DRAIN_WITH_ADMISSION",
        )
    }
    pub(crate) fn assert_cleanup_provenance(
        &self,
        binding: &WorkerOriginalHandlersCleanupBinding,
    ) -> Result<()> {
        self.record
            .original_cleanup
            .lock()
            .map_err(|_| GateError::Refused("POOL_TRANSITION_REQUIRES_RECONCILIATION"))?
            .as_ref()
            .ok_or(GateError::Refused("POOL_TRANSITION_CLEANUP_NOT_BOUND"))?
            .assert_same_selection(binding)?;
        Ok(())
    }
    pub(in crate::reservation_gate) fn legacy_fleet_cleanup(
        &self,
        closed: &reverie_host::worker_reports::WorkerOriginalHandlersClosed,
        targets: Vec<WorkerContainerName>,
    ) -> Result<OriginalCleanupAdmission> {
        self.assert_cleanup_selection(&closed.cleanup_binding())?;
        let snapshot = self.gate.installed.snapshot()?;
        Ok(OriginalCleanupAdmission {
            record: Arc::clone(&self.record),
            target: CleanupTarget::LegacyFleet {
                base: snapshot.envelope().base().clone(),
                targets: Arc::new(targets),
            },
        })
    }
}
impl Inner {
    pub(in crate::reservation_gate) fn original_cleanup(
        &self,
        connection: &WorkerLaunchConnection,
        target: &WorkerContainerName,
        runtime: &WorkerRuntime,
    ) -> Result<Option<OriginalCleanupAdmission>> {
        let record = self
            .pool_transition
            .lock()
            .map_err(|_| GateError::Refused("POOL_TRANSITION_REQUIRES_RECONCILIATION"))?
            .clone();
        let Some(record) = record else {
            return Ok(None);
        };
        {
            let binding = record
                .original_cleanup
                .lock()
                .map_err(|_| GateError::Refused("POOL_TRANSITION_REQUIRES_RECONCILIATION"))?;
            binding
                .as_ref()
                .ok_or(GateError::Refused(
                    "POOL_TRANSITION_REQUIRES_RECONCILIATION",
                ))?
                .assert_original(connection, runtime)?;
        }
        let snapshot = self.installed.snapshot()?;
        let selected = WorkerContainerName::from_recovered_name_data(
            snapshot.envelope().base(),
            target.as_str(),
        );
        need(
            selected.is_some_and(|(session, _)| &session == connection.request().session()),
            "WORKER_HANDLER_CLEANUP_TARGET",
        )?;
        let admitted = OriginalCleanupAdmission {
            record,
            target: CleanupTarget::OriginalHandler(target.clone()),
        };
        admitted.assert_selected(self)?;
        Ok(Some(admitted))
    }
    pub(in crate::reservation_gate) fn assert_entry_purpose(
        &self,
        cleanup: Option<&OriginalCleanupAdmission>,
    ) -> Result<()> {
        match cleanup {
            Some(cleanup) => cleanup.assert_selected(self),
            None => self.assert_no_pool_transition(),
        }
    }
    pub(in crate::reservation_gate) fn assert_pool_guard(&self) -> Result<()> {
        let record = self
            .pool_transition
            .lock()
            .map_err(|_| GateError::Refused("POOL_TRANSITION_REQUIRES_RECONCILIATION"))?
            .clone();
        if record.is_none() {
            return Ok(());
        }
        let active = self
            .held(None)
            .map_err(|_| GateError::Refused("POOL_TRANSITION_REQUIRES_RECONCILIATION"))?;
        active
            .original_cleanup
            .as_ref()
            .ok_or(GateError::Refused(
                "POOL_TRANSITION_REQUIRES_RECONCILIATION",
            ))?
            .assert_selected(self)
    }
}
impl OriginalCleanupAdmission {
    pub(in crate::reservation_gate) fn assert_fleet_history(
        &self,
        gate: &Arc<Inner>,
    ) -> Result<()> {
        if !matches!(&self.target, CleanupTarget::LegacyFleet { .. }) {
            return Ok(());
        }
        self.assert_pending(gate)?;
        gate.require_host_job_idle()?;
        let document = gate.document()?;
        need(
            gate.active_operations(&document)?.is_empty(),
            "POOL_TRANSITION_RESOURCE_WORK_RETAINED",
        )?;
        need(
            document.operations().is_empty(),
            "POOL_TRANSITION_RESOURCE_HISTORY_RETAINED",
        )?;
        need(
            reservation_control::read_host_job_intent(gate.config()?.as_ref())?.is_none(),
            "POOL_TRANSITION_HOST_HISTORY_RETAINED",
        )
    }
    pub(in crate::reservation_gate) fn assert_selected(&self, gate: &Inner) -> Result<()> {
        need(
            gate.pool_transition
                .lock()
                .map_err(|_| GateError::Refused("POOL_TRANSITION_REQUIRES_RECONCILIATION"))?
                .as_ref()
                .is_some_and(|actual| Arc::ptr_eq(actual, &self.record)),
            "POOL_TRANSITION_REQUIRES_RECONCILIATION",
        )?;
        self.record
            .intent
            .assert_configuration(gate.config()?.configuration())?;
        Ok(())
    }
    pub(in crate::reservation_gate) fn assert_pending(&self, gate: &Inner) -> Result<()> {
        self.assert_selected(gate)?;
        self.record.assert_pending()
    }
    pub(in crate::reservation_gate) fn assert_target(
        &self,
        target: &WorkerContainerName,
    ) -> Result<()> {
        let selected = match &self.target {
            CleanupTarget::OriginalHandler(original) => original == target,
            CleanupTarget::LegacyFleet { base, targets } => {
                targets.contains(target)
                    && WorkerContainerName::from_recovered_name_data(base, target.as_str())
                        .is_some()
            }
        };
        need(selected, "WORKER_HANDLER_CLEANUP_TARGET")
    }
}
