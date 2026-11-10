use super::*;
use reverie_core::gpu_access::{GpuGrantSource, GpuIntent};
use reverie_store::storage_identity::{self, StorageIdentityConfig};
impl<P: Platform> Service<'_, P> {
    pub(super) fn request(
        &self,
        selector: GpuEmployeeSelector,
        intent: GpuIntent,
        end: Instant,
    ) -> Result<GpuStatusData> {
        let admission = self.gate.inner.admit(Self::bounds(end))?;
        let result = self.queue(Employee::Selector(selector), &intent, None);
        let (employee, request) = admission.conclude(result)?;
        self.apply(&employee, &request, end)?;
        self.status(Employee::Checked(employee), end)
    }
    pub(super) fn queue(
        &self,
        employee: Employee,
        intent: &GpuIntent,
        website: Option<&WebsiteGpu<'_, '_>>,
    ) -> Result<(JournalId, GpuQueuedRequest)> {
        let config = self.gate.inner.config()?;
        let config = config.configuration();
        let files = self.files(config)?;
        let original = self.private_current(&files, config)?;
        let employee = employee.resolve()?;
        let current = reverie_host::gpu_access::current_employee(config, &employee)?;
        WebsiteGpu::require_current(website, self.gate, &current)?;
        let binding = self.binding(config, &current)?;
        let (requests, stamp) = self.requests(&files)?;
        let previous = requests.requests().get(&employee);
        intent
            .assert_current(&binding, previous)
            .map_err(gpu_access::GpuDataError::from)?;
        if let Some(device) = intent.device() {
            need(
                self.platform
                    .catalogue()?
                    .iter()
                    .any(|value| value.device() == device),
                "GPU_HARDWARE_UNAVAILABLE",
            )?;
        }
        let applied = gpu_access::applied(config, current.data())?;
        if applied.source() == GpuGrantSource::LegacySession {
            need(
                applied.device() == intent.device(),
                "GPU_LEGACY_SESSION_OVERRIDE",
            )?;
        }
        let queued = intent
            .queued(&binding, previous)
            .map_err(gpu_access::GpuDataError::from)?;
        let document = requests
            .with_queued(employee.clone(), queued.clone())
            .map_err(gpu_access::GpuDataError::from)?;
        self.gate.inner.guard(None)?;
        let latest = reverie_host::gpu_access::current_employee(config, &employee)?;
        need(
            latest.data() == current.data() && self.private_current(&files, config)? == original,
            "GPU_REQUEST_CAS_CHANGED",
        )?;
        WebsiteGpu::require_current(website, self.gate, &latest)?;
        files.publish_requests(&document, stamp.as_ref())?;
        Ok((employee, queued))
    }
    pub(super) fn cold(&self, session: &ProfileSessionId) -> Result<()> {
        let config = self.gate.inner.config()?;
        let files = GpuControlFiles::capture_control(config.configuration());
        if !files.queue_present()? {
            return Ok(());
        }
        let end = Instant::now() + Duration::from_secs(30);
        let admission = self.gate.inner.admit(Self::bounds(end))?;
        let selected = admission.conclude(self.cold_intent(session))?;
        let Some((employee, queued, current)) = selected else {
            return Ok(());
        };
        if queued.session().as_str() != session.as_str()
            || queued.generation().get().to_string() != current.generation().decimal()
        {
            return Ok(());
        }
        let current = GpuCurrentEmployee::from_current(current, &employee)?;
        let config = self.gate.inner.config()?;
        if self.binding(config.configuration(), &current)?.digest() != queued.digest() {
            return Ok(());
        }
        self.apply(&employee, &queued, end)
    }
    fn cold_intent(
        &self,
        session: &ProfileSessionId,
    ) -> Result<
        Option<(
            JournalId,
            GpuQueuedRequest,
            reverie_contracts::storage_identity::CurrentEmployee,
        )>,
    > {
        let config = self.gate.inner.config()?;
        let config = config.configuration();
        let files = GpuControlFiles::capture_control(config);
        let (requests, _) = self.requests(&files)?;
        let settings =
            reverie_contracts::resource_config::ResourceIdentitySettings::capture_worker_config(
                config,
            )?;
        let identity = StorageIdentityConfig::capture_worker_settings(&settings);
        let Some(current) = storage_identity::current_employee(&identity, session)? else {
            return Ok(None);
        };
        let selected = requests
            .requests()
            .iter()
            .find(|(employee, _)| employee.as_str() == current.identity().as_str());
        let paths = storage_identity::storage_paths(&identity, session)?;
        if !storage_identity::storage_start_allowed(&identity, &paths)? {
            return Ok(None);
        }
        Ok(selected.map(|(employee, request)| (employee.clone(), request.clone(), current)))
    }
}
