use super::*;
impl Observer<'_> {
    pub(super) fn finish(&self, initial: Initial, config_path: &Path) -> Result<Vec<u8>> {
        let second_cdi = GpuHardware::preflight_cdi(
            &initial.information,
            &self.request.device,
            Instant::now() + Duration::from_secs(5),
        )?;
        if !second_cdi.equivalent(&initial.cdi) {
            return Err("CDI specification changed during preflight".into());
        }
        let information = GpuEngineInformation::decode_preflight(
            &self.engine.query(GpuPreflightQuery::Information)?,
        )?;
        if !information.equivalent(&initial.information) {
            return Err("Engine identity or CDI selection changed during preflight".into());
        }
        if !self.laptop(&initial.binding)?.equivalent(&initial.laptop) {
            return Err("Native laptop facts changed during preflight".into());
        }
        if GpuHardware::physical_device(&self.request.device)? != initial.physical {
            return Err("Physical GPU changed during preflight".into());
        }
        let resources =
            effective_config(self.config().clone(), initial.binding.current().session())?;
        let configured = self.grant(self.config(), &initial.binding)?;
        if let Some(pid) = initial.laptop.process_pid()? {
            let process = gpu_access::preflight_process(&pid)?;
            if !initial.laptop.process_matches(&process) {
                return Err("Current laptop process changed".into());
            }
        }
        if !gpu_access::preflight_binding(self.config(), &self.request.employee)?
            .equivalent(&initial.binding)
        {
            return Err("Employee identity or owner intent changed during preflight".into());
        }
        let engine = PreflightEngineData::new(initial.endpoint, initial.information);
        let report = PreflightReport {
            config: self.config(),
            candidate: &initial.candidate,
            binding: &initial.binding,
            engine: &engine,
            device: &self.request.device,
            physical: &initial.physical,
            cdi: initial.cdi.data(),
            image: &initial.image,
            image_labels: &initial.labels,
            laptop: &initial.laptop,
            resources: &resources,
            configured: configured.as_ref(),
        }
        .capture()?;
        let after = load(config_path)?;
        if !worker_config::equivalent(self.config(), after.configuration()) {
            return Err("Broker configuration changed during preflight".into());
        }
        Ok(report.encode()?)
    }
}
