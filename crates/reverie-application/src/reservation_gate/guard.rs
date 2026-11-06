use super::*;
struct InstalledGuard(Weak<Inner>);
pub(super) fn installed(gate: &Arc<Inner>) -> Arc<dyn ScopeGuard> {
    Arc::new(InstalledGuard(Arc::downgrade(gate)))
}
impl ScopeGuard for InstalledGuard {
    fn assert_scope(&self, scope: &OperationScope) -> std::result::Result<(), JournalError> {
        let gate = self
            .0
            .upgrade()
            .ok_or_else(|| JournalError::refusal("RESERVATION_ADMISSION_LOCK_REQUIRED"))?;
        gate.guard(Some(scope))
            .map(|_| ())
            .map_err(|error| JournalError::guard_failure(error.code(), error))
    }
    fn assert_terminal_admission(
        &self,
        scope: &OperationScope,
    ) -> std::result::Result<(), JournalError> {
        let gate = self
            .0
            .upgrade()
            .ok_or_else(|| JournalError::refusal("RESERVATION_ADMISSION_LOCK_REQUIRED"))?;
        gate.held(Some(scope))
            .map(|_| ())
            .map_err(|error| JournalError::guard_failure(error.code(), error))
    }
}
impl Inner {
    pub(super) fn held(&self, scope: Option<&OperationScope>) -> Result<Arc<Active>> {
        let state = self
            .state
            .lock()
            .map_err(|_| GateError::Refused("RESERVATION_ADMISSION_UNAVAILABLE"))?;
        let active = state
            .active
            .as_ref()
            .ok_or(GateError::Refused("RESERVATION_ADMISSION_LOCK_REQUIRED"))?;
        need(
            active.thread == std::thread::current().id() && active.process == std::process::id(),
            "RESERVATION_ADMISSION_LOCK_REQUIRED",
        )?;
        need(
            scope.is_none_or(|selected| *selected == self.scope),
            "RESERVATION_SCOPE_CHANGED",
        )?;
        Ok(active.clone())
    }
    pub(super) fn guard(&self, scope: Option<&OperationScope>) -> Result<ObservedInventory> {
        let active = self.held(scope)?;
        let inherited = *active
            .deadline
            .lock()
            .map_err(|_| GateError::Refused("RESERVATION_ADMISSION_UNAVAILABLE"))?;
        let end = active.context.deadline(inherited)?;
        need(
            domain_digest(self.config.configuration())? == *self.binding.domain(),
            "RESERVATION_DOMAIN_CHANGED",
        )?;
        need(
            !reservation_control::pending_present(&self.config)?,
            "RESERVATION_INSTALL_REQUIRES_RECONCILIATION",
        )?;
        let image = self
            .source_path
            .as_deref()
            .map(|path| {
                reservation_control::capture_current_image(path, self.config.configuration())
            })
            .transpose()?;
        need(
            self.binding
                .matches_metadata(&reservation_control::read_marker(&self.config)?),
            "RESERVATION_BINDING_CHANGED",
        )?;
        let lock = active
            .lock
            .lock()
            .map_err(|_| GateError::Refused("RESERVATION_ADMISSION_UNAVAILABLE"))?;
        reservation_control::guard_layout(&self.config, &self.binding, &lock)?;
        drop(lock);
        let rows = active.context.custody(Some(end))?;
        need(Instant::now() < end, "RESERVATION_OBSERVATION_DEADLINE")?;
        if let Some(image) = image {
            image.assert_current()?;
        }
        Ok(rows)
    }
    pub(super) fn store(self: &Arc<Self>) -> Result<OperationStore> {
        // The path comes from the captured validated option. This conversion
        // retains its codepoints through the one native text owner.
        let path = reverie_host::reservation_control::operation_directory(&self.config)?;
        Ok(OperationStore::open(path, installed(self), None)?)
    }
}
