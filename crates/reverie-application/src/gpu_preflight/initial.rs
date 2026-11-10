use super::*;
use reverie_contracts::storage_identity::MetadataText;
use std::os::unix::ffi::OsStrExt;
impl Observer<'_> {
    pub(super) fn initial(&self) -> Result<Initial> {
        let binding = gpu_access::preflight_binding(self.config(), &self.request.employee)?;
        let candidate = PreflightCandidate::project(
            self.config(),
            &self.request.employee,
            &self.request.device,
        )?;
        if self.grant(candidate.configuration(), &binding)?.as_ref() != Some(&self.request.device) {
            return Err("An explicit SID grant overrides this employee selection".into());
        }
        let endpoint = match self.engine.endpoint_hint() {
            Some(value) => PreflightEndpoint::from_text(reverie_core::PythonText::try_new(
                reverie_core::posix_text::decode(value.as_bytes()),
            )?)?,
            None => PreflightEndpoint::decode(&self.engine.query(GpuPreflightQuery::Endpoint)?)?,
        };
        let information = GpuEngineInformation::decode_preflight(
            &self.engine.query(GpuPreflightQuery::Information)?,
        )?;
        GpuHardware::require_same_kernel(&information)?;
        let cdi = GpuHardware::preflight_cdi(
            &information,
            &self.request.device,
            Instant::now() + Duration::from_secs(5),
        )?;
        let physical = GpuHardware::physical_device(&self.request.device)?;
        let expected = MetadataText::from_scalar_text(&format!("/dev/nvidia{}", physical.minor()));
        if cdi.data().edits().numeric_nodes() != [expected] {
            return Err("CDI physical node does not match the current GPU UUID".into());
        }
        if self
            .request
            .cdi_digest
            .as_ref()
            .is_some_and(|digest| digest.as_str() != cdi.observation().sha256())
        {
            return Err("Reviewed CDI specification changed".into());
        }
        let image = match &self.request.image {
            Some(image) => image.clone(),
            None => WorkerImageId::parse(self.snapshot.envelope().base().image())?,
        };
        let raw = self.engine.query(GpuPreflightQuery::Image(&image))?;
        let artifact = PreflightImage::decode(&raw, &image)?;
        let rootless = RootlessConfig::capture(self.config().clone())?;
        rootless::require_rootless_image(&rootless, &RootlessImage::decode(&raw)?)?;
        let labels = artifact.labels()?;
        if self.request.browser && !labels.browser_profile()? {
            return Err("Matching opt-in browser image must be built and qualified first".into());
        }
        let laptop = self.laptop(&binding)?;
        Ok(Initial {
            binding,
            candidate,
            endpoint,
            information,
            cdi,
            physical,
            image,
            labels,
            laptop,
        })
    }
}
