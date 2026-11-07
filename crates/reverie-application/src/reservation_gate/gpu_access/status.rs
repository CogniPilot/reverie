use super::*;
use reverie_core::gpu_access::{GpuActiveData, GpuApplied, GpuChoicesData};
impl<P: Platform> Service<'_, P> {
    pub(super) fn status(&self, employee: Employee, end: Instant) -> Result<GpuStatusData> {
        let admission = self.gate.inner.admit(Self::bounds(end))?;
        let result = self.status_body(employee, end);
        admission.conclude(result)
    }
    fn status_body(&self, employee: Employee, end: Instant) -> Result<GpuStatusData> {
        let config = self.gate.inner.config()?;
        let config = config.configuration();
        let files = self.files(config)?;
        let original = self.private_current(&files, config)?;
        let employee = employee.resolve()?;
        let current = reverie_host::gpu_access::current_employee(config, &employee)?;
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
            Err(_) => GpuChoicesData::unknown(),
        };
        let native = self.gate.inner.native_context()?;
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
        Ok(
            GpuStatusData::new(employee, binding, request, choices, applied, active)
                .map_err(gpu_access::GpuDataError::from)?,
        )
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
        Ok(if observed.is_ok() {
            GpuActiveData::ObservedDevice(device.clone())
        } else {
            GpuActiveData::UnknownRunning
        })
    }
}
