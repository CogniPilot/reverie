use super::*;
use reverie_core::gpu_access::{GpuActiveData, GpuApplied, GpuChoicesData, GpuStatusState};
impl<P: Platform> Service<'_, P> {
    pub(super) fn status(&self, employee: Employee, end: Instant) -> Result<GpuStatusData> {
        let admission = self.gate.inner.admit(Self::bounds(end))?;
        let result = self.status_body(employee, end, None).map(|(data, _)| data);
        admission.conclude(result)
    }
    pub(super) fn status_body(
        &self,
        employee: Employee,
        end: Instant,
        website: Option<&WebsiteGpu<'_, '_>>,
    ) -> Result<(GpuStatusData, bool)> {
        let config = self.gate.inner.config()?;
        let config = config.configuration();
        let files = self.files(config)?;
        let original = self.private_current(&files, config)?;
        let employee = employee.resolve()?;
        let current = reverie_host::gpu_access::current_employee(config, &employee)?;
        WebsiteGpu::require_current(website, self.gate, &current)?;
        let binding = self.binding(config, &current)?;
        let (requests, request_stamp) = self.requests(&files)?;
        let request = requests.requests().get(&employee).cloned();
        let rows = self.gate.inner.guard(None)?;
        let selected = rows.gpu_selected(config, current.data())?;
        let applied = gpu_access::applied(config, current.data())?;
        let active = self.active(
            config,
            current.data().session(),
            selected.as_ref(),
            &applied,
        )?;
        let choices = match self.platform.catalogue() {
            Ok(choices) => {
                GpuChoicesData::known(choices).map_err(gpu_access::GpuDataError::from)?
            }
            Err(error) if error.has_unconfirmed_close() => return Err(error.into()),
            Err(_) => GpuChoicesData::unknown(),
        };
        let native = self.gate.inner.native_context()?;
        let status = GpuStatusData::new(
            employee.clone(),
            binding.clone(),
            request,
            choices,
            applied,
            active,
        )
        .map_err(gpu_access::GpuDataError::from)?;
        let can_apply = website.is_some_and(WebsiteGpu::observes_apply_readiness)
            && status.state() == GpuStatusState::Pending
            && matches!(status.active(), GpuActiveData::Stopped)
            && status
                .requested()
                .is_some_and(|queued| queued.matches_binding(status.current()))
            && reverie_host::gpu_access::installed_terminal().is_ok_and(|installed| !installed)
            && website::stopped_target(selected.as_ref(), &native, end)?;
        need(
            native.inventory(Some(end))?.equivalent(&rows),
            "GPU_NATIVE_CHANGED",
        )?;
        let latest = reverie_host::gpu_access::current_employee(config, &employee)?;
        need(
            latest.data() == current.data()
                && self.binding(config, &latest)? == binding
                && self.private_current(&files, config)? == original
                && self.requests(&files)?.1 == request_stamp,
            "GPU_STATUS_CHANGED",
        )?;
        WebsiteGpu::require_current(website, self.gate, &latest)?;
        Ok((status, can_apply))
    }
    fn active(
        &self,
        config: &EffectiveWorkerConfig,
        session: &ProfileSessionId,
        row: Option<&crate::reservation_observer::ObservedRow<'_>>,
        applied: &GpuApplied,
    ) -> Result<GpuActiveData> {
        let Some(row) = row else {
            return Ok(GpuActiveData::Stopped);
        };
        if !row.data().running()? {
            return Ok(GpuActiveData::Stopped);
        }
        let Some(device) = applied.device() else {
            return Ok(GpuActiveData::UnknownRunning);
        };
        let effective = crate::resource_staging::effective_config(config.clone(), session)?;
        if !gpu_access::policy_label_matches(row.data(), &worker_config::policy_digest(&effective))?
        {
            return Ok(GpuActiveData::UnknownRunning);
        }
        let observed = (|| {
            let physical = self.platform.physical(device)?;
            self.gate.inner.native_context()?.limits(row)?;
            self.platform.active(&row.data().pid()?, &physical)?;
            Ok::<_, GateError>(())
        })();
        match observed {
            Ok(()) => Ok(GpuActiveData::ObservedDevice(device.clone())),
            Err(error) if crate::installing_broker::resource_actor::gate_close_unknown(&error) => {
                Err(error)
            }
            Err(_) => Ok(GpuActiveData::UnknownRunning),
        }
    }
}
