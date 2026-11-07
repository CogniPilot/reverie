//! Original second-pane -> wait_current -> stop admission -> late policy.
use super::*;
use reverie_contracts::worker_config;
use reverie_host::worker_launch::ExistingPaneState;
impl ColdBody<'_> {
    pub(super) fn stop_existing(&mut self) -> Result<(), ColdError> {
        let Resources::Direct(input) = self.resources.as_ref().expect("actual first phase") else {
            unreachable!("classified phase")
        };
        if matches!(input.target, ExistingColdTarget::Absent) {
            let Resources::Direct(input) = self.resources.take().expect("same phase") else {
                unreachable!("checked Direct")
            };
            self.resources = Some(Resources::Stopped(Stopped { storage: input.storage, plan: input.plan, removal: None }));
            return Ok(());
        }
        let replacing = matches!(input.target, ExistingColdTarget::DeadPane(_) | ExistingColdTarget::RunningCompleted(_));
        if let ExistingColdTarget::DeadPane(process) = &input.target
            && process.observe_dead_pane_again(&self.broker().storage.runtime, &input.plan, self.end())
                .map_err(PreparationError::ExistingHost)? != ExistingPaneState::Dead {
            return Err(ColdError::Refused("Existing laptop pane changed; reconnect before restarting"));
        }
        if replacing { self.wait_current()?; }
        let target = WorkerContainerName::from_launch_name_data(input.plan.arguments().worker_name());
        let admission = self.broker().admit_ordinary_stop(&target)?;
        let result = (|| {
            admission.assert_broker(self.broker())?;
            admission.assert_target(&target)?;
            self.stop_target()
        })();
        match result {
            Ok(()) => admission.close().map_err(Into::into),
            Err(primary) => match admission.abort() {
                Ok(()) => Err(primary),
                Err(secondary) => Err(error::finalized(primary, secondary.into())),
            },
        }?;
        if replacing { self.check_after_running_stop()?; }
        Ok(())
    }
    fn stop_target(&mut self) -> Result<(), ColdError> {
        let Resources::Direct(input) = self.resources.take().expect("actual stop inputs") else { unreachable!("actual Direct") };
        let Direct { storage, plan, target } = input;
        let dead = matches!(&target, ExistingColdTarget::DeadPane(_));
        match target {
            ExistingColdTarget::DeadPane(process) | ExistingColdTarget::RunningCompleted(process) => {
                match storage.retain_replacement_stop(plan, process, None) {
                    Ok(native) => self.resources = Some(Resources::Replacement(native)),
                    Err(failure) => {
                        let (storage, plan, process, cause) = failure.into_parts();
                        let target = if dead { ExistingColdTarget::DeadPane(process) } else { ExistingColdTarget::RunningCompleted(process) };
                        self.resources = Some(Resources::Direct(Direct { storage, plan, target }));
                        return Err(cause.into());
                    }
                }
                self.stop_replacement()
            }
            ExistingColdTarget::Stopped(previous) => {
                match storage.retain_ordinary_stop(plan, previous) {
                    Ok(native) => self.resources = Some(Resources::Legacy(native)),
                    Err(failure) => {
                        let (storage, plan, previous, cause) = failure.into_parts();
                        self.resources = Some(Resources::Direct(Direct { storage, plan, target: ExistingColdTarget::Stopped(previous) }));
                        return Err(cause.into());
                    }
                }
                let Resources::Legacy(native) = self.resources.as_ref().expect("same legacy owner") else { unreachable!() };
                native.stop_after_admission()?;
                let Resources::Legacy(native) = self.resources.take().expect("same legacy owner") else { unreachable!() };
                match native.reclaim(self.end()) {
                    Ok(returned) => {
                        let (storage, plan, _previous, removal) = returned.into_cold_parts();
                        self.resources = Some(Resources::Stopped(Stopped { storage, plan, removal: Some(removal) }));
                        Ok(())
                    }
                    Err(failure) => {
                        let (native, cause) = failure.into_parts(); self.resources = Some(Resources::Legacy(native)); Err(cause.into())
                    }
                }
            }
            ExistingColdTarget::Absent => unreachable!("absent branch never stops"),
        }
    }
    fn stop_replacement(&mut self) -> Result<(), ColdError> {
        let Resources::Replacement(native) = self.resources.as_ref().expect("actual replacement") else { unreachable!() };
        native.inspect()?;
        let policy = (|| {
            let snapshot = self.broker().configuration()?;
            crate::resource_staging::effective_config(snapshot.configuration().clone(),
                self.scope.preparing.admitted.request().session()).map_err(PreparationError::from)
        })();
        let resources = match policy {
            Ok(resources) => resources,
            Err(primary) => return Err(match native.refuse_policy() {
                Ok(()) => primary.into(), Err(secondary) => error::finalized(primary.into(), secondary.into()),
            }),
        };
        native.stop_after_policy(&worker_config::policy_digest(&resources))?;
        let Resources::Replacement(native) = self.resources.take().expect("actual stopped owner") else { unreachable!() };
        match native.reclaim(self.end()) {
            Ok(returned) => {
                let (storage, plan, _process, removal) = returned.into_cold_parts();
                self.resources = Some(Resources::Stopped(Stopped { storage, plan, removal: Some(removal) }));
                Ok(())
            }
            Err(failure) => {
                let (native, cause) = failure.into_parts(); self.resources = Some(Resources::Replacement(native)); Err(cause.into())
            }
        }
    }
    pub(super) fn wait_current(&self) -> Result<(), ColdError> {
        self.scope.observed.check(&self.scope.preparing, self.lifecycle()).map_err(Into::into)
    }
    fn check_after_running_stop(&self) -> Result<(), ColdError> {
        self.wait_current()?;
        let Resources::Stopped(input) = self.resources.as_ref().expect("known actual stop") else { unreachable!() };
        let source = self.broker().configuration()?;
        let selected = self.broker().storage.runtime.resolve_storage(source.configuration(), input.plan.session())
            .map_err(StorageWorkflowError::from)?;
        if selected.paths() != input.storage.paths() { return Err(ColdError::Refused("Employee storage or running intent changed during replacement")); }
        input.storage.require_launch_start_allowed(source.configuration())?;
        let current = crate::resource_staging::effective_config(source.configuration().clone(), input.plan.session())
            .map_err(PreparationError::from)?;
        if !worker_config::equivalent(&current, &self.scope.resources) { return Err(ColdError::Refused("Laptop policy changed during replacement")); }
        self.broker().check_creation_budget_locked(self.lifecycle(), input.plan.session(), &self.scope.resources,
            self.scope.preparing.admitted.admission.as_ref()).map_err(PreparationError::from).map_err(Into::into)
    }
}
