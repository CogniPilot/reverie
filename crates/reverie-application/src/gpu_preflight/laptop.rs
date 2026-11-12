use super::*;
impl Observer<'_> {
    pub(super) fn laptop(&self, binding: &PreflightBinding) -> Result<PreflightLaptopData> {
        let session = binding.current().session();
        let base = self.snapshot.envelope().base();
        let raw = self
            .engine
            .query(GpuPreflightQuery::Laptop { base, session })?;
        let item = PreflightLaptop::decode(&raw, base, binding)?;
        let resources = effective_config(self.config().clone(), session)?;
        item.require_identity(base)?;
        let rootless = RootlessConfig::capture(self.config().clone())?;
        item.require_capabilities(rootless::observe_rootless(&rootless)?.enabled())?;
        item.require_limits(&resources)?;
        let policy = effective_config(self.config().clone(), session)?;
        item.require_policy(&worker_config::policy_digest(&policy))?;
        let process = item
            .process_pid()?
            .map(|pid| gpu_access::preflight_process(&pid))
            .transpose()?;
        Ok(item.project(process.as_ref())?)
    }
}
