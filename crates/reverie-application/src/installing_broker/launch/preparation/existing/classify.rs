//! Original memory -> runtime/exit -> pane -> replacement identity -> budget.
//! Classification retains the whole accepted resource owner; no stop is sent.
use super::{receipt::RuntimeWorkerLaunch, *};
use reverie_contracts::{
    resource_config::{ResourceConfiguration, checked_effective_policy},
    worker_config::EffectiveWorkerConfig,
};
use reverie_core::resources::BudgetMode;
use reverie_host::worker_launch::{ExistingPaneState, ExistingProcessIncarnation};

#[must_use = "continue the same actual launch or retain its failure owners"]
pub enum ClassifiedWorkerLaunch<'a> {
    Reuse(ReusableWorkerLaunch<'a>),
    Cold(ColdWorkerLaunch<'a>),
}
#[must_use = "live pane readback is not admission, guard or resource release"]
pub struct ReusableWorkerLaunch<'a> {
    receipt: Option<reverie_host::worker_storage::LaunchReceiptObservation>,
    pub(in crate::installing_broker::launch::preparation) inspected: InspectedWorkerLaunch<'a>,
    pub(in crate::installing_broker::launch::preparation) resources: EffectiveWorkerConfig,
}
#[must_use = "existing laptops still require genuine ordinary stop before create"]
pub struct ColdWorkerLaunch<'a> {
    pub(in crate::installing_broker::launch::preparation) inspected: InspectedWorkerLaunch<'a>,
    pub(in crate::installing_broker::launch::preparation) resources: EffectiveWorkerConfig,
    pub(in crate::installing_broker::launch::preparation) target: ExistingColdTarget,
}
/// Closed original-source branch, never fabricated from CID/PID/path DATA.
/// The actual ColdWorkerLaunch owns this with its original accepted resources.
pub enum ExistingColdTarget {
    Absent,
    Stopped(ExistingLaptopInspection),
    DeadPane(ExistingProcessIncarnation),
    RunningCompleted(ExistingProcessIncarnation),
}
impl<'a> InspectedWorkerLaunch<'a> {
    /// Continue the original actual J, admission, lifecycle, storage and first
    /// inspect. Neither absent inspect nor an attach flag bypasses these phases.
    pub fn classify_existing(
        self,
    ) -> Result<ClassifiedWorkerLaunch<'a>, Box<PreparationFailure<'a>>> {
        self.verify_running()?.read_runtime()?.classify()
    }
}
impl<'a> RuntimeWorkerLaunch<'a> {
    fn classify(mut self) -> Result<ClassifiedWorkerLaunch<'a>, Box<PreparationFailure<'a>>> {
        let observed = (|| {
            let (reuse, mut target) = self.initial_pane()?;
            let inspected = &self.verified.existing;
            let attach = inspected.request().attach_only() == Some(true);
            if attach && !reuse {
                return Err(PreparationError::Refused(
                    "The existing laptop is unavailable; reconnect never starts a replacement",
                ));
            }
            if attach && self.pane()? != ExistingPaneState::Live {
                return Err(PreparationError::Refused(
                    "The existing laptop process has exited",
                ));
            }
            if self.verified.running && !reuse && target.is_none() {
                target = Some(ExistingColdTarget::RunningCompleted(
                    self.capture_process(false)?,
                ));
            }
            self.budgets(reuse)
                .map(|resources| (reuse, resources, target))
        })();
        match observed {
            Ok((true, resources, _)) => Ok(ClassifiedWorkerLaunch::Reuse(ReusableWorkerLaunch {
                inspected: self.verified.existing,
                receipt: self.receipt,
                resources,
            })),
            Ok((false, resources, target)) => {
                let target = target.unwrap_or_else(|| {
                    self.verified
                        .existing
                        .previous
                        .take()
                        .map_or(ExistingColdTarget::Absent, ExistingColdTarget::Stopped)
                });
                Ok(ClassifiedWorkerLaunch::Cold(ColdWorkerLaunch {
                    inspected: self.verified.existing,
                    resources,
                    target,
                }))
            }
            Err(cause) => Err(self.into_failure(cause)),
        }
    }
    fn initial_pane(&mut self) -> Result<(bool, Option<ExistingColdTarget>), PreparationError> {
        if !self.verified.running
            || self
                .receipt
                .as_ref()
                .expect("running runtime read")
                .exists()
        {
            return Ok((false, None));
        }
        match self.pane()? {
            ExistingPaneState::Live => Ok((true, None)),
            ExistingPaneState::Dead => Ok((
                false,
                Some(ExistingColdTarget::DeadPane(self.capture_process(true)?)),
            )),
            ExistingPaneState::Unavailable => Err(PreparationError::Refused(
                "Existing laptop pane state is unavailable; no replacement was started",
            )),
        }
    }
    fn end(&self) -> Instant {
        let end = Instant::now() + std::time::Duration::from_secs(20);
        self.verified
            .existing
            .observed
            .claimed
            .preparing
            .broker()
            .storage
            .runtime
            .stop_deadline()
            .map_or(end, |stop| end.min(stop))
    }
    fn pane(&self) -> Result<ExistingPaneState, PreparationError> {
        let inspected = &self.verified.existing;
        inspected
            .previous
            .as_ref()
            .expect("actual running first inspection")
            .observe_pane(
                &inspected
                    .observed
                    .claimed
                    .preparing
                    .broker()
                    .storage
                    .runtime,
                &inspected.observed.plan,
                self.end(),
            )
            .map_err(PreparationError::ExistingHost)
    }
    fn capture_process(
        &mut self,
        dead: bool,
    ) -> Result<ExistingProcessIncarnation, PreparationError> {
        let end = self.end();
        let inspected = &mut self.verified.existing;
        let previous = inspected
            .previous
            .take()
            .expect("one actual first observation");
        let runtime = &inspected
            .observed
            .claimed
            .preparing
            .broker()
            .storage
            .runtime;
        let result = if dead {
            previous.capture_dead_pane_process(runtime, &inspected.observed.plan, end)
        } else {
            previous.capture_running_replacement_process(runtime, &inspected.observed.plan, end)
        };
        result.map_err(PreparationError::ExistingCapture)
    }
    fn budgets(&self, reuse: bool) -> Result<EffectiveWorkerConfig, PreparationError> {
        let inspected = &self.verified.existing;
        let observed = &inspected.observed;
        let source = observed.current.configuration();
        let session = observed.plan.session();
        let broker = observed.claimed.preparing.broker();
        let resources = crate::resource_staging::effective_config(source.clone(), session)?;
        if reuse {
            if checked_effective_policy(&resources)?.budget_mode() == BudgetMode::Pool {
                broker.check_pool(&resources, false)?;
            }
            return Ok(resources);
        }
        observed
            .claimed
            .storage
            .as_ref()
            .expect("same actual storage")
            .require_launch_start_allowed(source)?;
        let resources = crate::resource_staging::effective_config(source.clone(), session)?;
        let config = ResourceConfiguration::capture(source.clone())?;
        broker.check_pool(
            if config.has_resource_maps() {
                &resources
            } else {
                source
            },
            true,
        )?;
        if !self.verified.running {
            broker.check_creation_budget_locked(
                &observed.claimed.lifecycle,
                session,
                &resources,
                observed.claimed.preparing.admitted.admission.as_ref(),
            )?;
        }
        Ok(resources)
    }
    fn into_failure(self, cause: PreparationError) -> Box<PreparationFailure<'a>> {
        let inspected = self.verified.existing;
        inspected
            .observed
            .claimed
            .into_failure(cause, Some(inspected.observed.current))
    }
}
impl<'a> ReusableWorkerLaunch<'a> {
    /// Original exit.exists DATA, not a completed command or viewer permit.
    pub fn receipt(&self) -> Option<&reverie_host::worker_storage::LaunchReceiptObservation> {
        self.receipt.as_ref()
    }
    pub fn request(&self) -> &WorkerRequest {
        self.inspected.request()
    }
    pub fn configuration(&self) -> &EffectiveWorkerConfig {
        &self.resources
    }
    pub fn abort(self) -> Box<PreparationFailure<'a>> {
        self.inspected.observed.claimed.into_failure(
            PreparationError::Refused("WORKER_LAUNCH_ABORTED"),
            Some(self.inspected.observed.current),
        )
    }
}
impl<'a> ColdWorkerLaunch<'a> {
    pub fn request(&self) -> &WorkerRequest {
        self.inspected.request()
    }
    pub fn configuration(&self) -> &EffectiveWorkerConfig {
        &self.resources
    }
    pub fn target(&self) -> &ExistingColdTarget {
        &self.target
    }
    pub fn previous_process(&self) -> Option<&ExistingProcessIncarnation> {
        match &self.target {
            ExistingColdTarget::DeadPane(process)
            | ExistingColdTarget::RunningCompleted(process) => Some(process),
            ExistingColdTarget::Absent | ExistingColdTarget::Stopped(_) => None,
        }
    }
    pub fn has_dead_inner(&self) -> bool {
        matches!(self.target, ExistingColdTarget::DeadPane(_))
    }
    pub fn abort(self) -> Box<PreparationFailure<'a>> {
        self.inspected.observed.claimed.into_failure(
            PreparationError::Refused("WORKER_LAUNCH_ABORTED"),
            Some(self.inspected.observed.current),
        )
    }
}

#[cfg(test)]
#[path = "classify_tests.rs"]
mod tests;
