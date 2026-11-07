use super::*;
impl Inner {
    pub(super) fn require_host_job_idle(&self) -> Result<()> {
        self.held(None)?;
        let (config, binding) = self.installed.bound_resources(&self.binding)?;
        need(
            !reservation_control::host_job_finishing_present(&config)?,
            "HOST_JOB_FINISH_REQUIRES_RECONCILIATION",
        )?;
        let Some(metadata) = reservation_control::read_host_job_intent(&config)? else {
            return Ok(());
        };
        let intent = reverie_contracts::host_jobs::HostJobIntent::capture(
            &metadata,
            &self.scope,
            binding.domain(),
        )?;
        reverie_host::host_jobs::qualify_path_declarations(intent.spec())?;
        let receipt = reservation_control::read_host_job_receipt(&config, intent.spec().job_id())?;
        intent.assert_receipt(&receipt)?;
        Ok(())
    }
}
