use super::*;
pub(super) struct InstalledGuard {
    gate: Weak<Inner>,
    purpose: JournalPurpose,
}
enum JournalPurpose {
    Ordinary,
    Ram {
        authority: Weak<super::ram_authority::RamJournalAuthority>,
        active: Weak<Active>,
    },
    Unavailable,
}
pub(super) fn installed(gate: &Arc<Inner>) -> Arc<InstalledGuard> {
    let purpose =
        match gate.state.lock() {
            Ok(state) => match state.active.as_ref() {
                Some(active) => match active.ram_authority.lock() {
                    Ok(selected) => selected.as_ref().map_or(JournalPurpose::Ordinary, |own| {
                        JournalPurpose::Ram {
                            authority: own.clone(),
                            active: Arc::downgrade(active),
                        }
                    }),
                    Err(_) => JournalPurpose::Unavailable,
                },
                None => JournalPurpose::Ordinary,
            },
            Err(_) => JournalPurpose::Unavailable,
        };
    Arc::new(InstalledGuard {
        gate: Arc::downgrade(gate),
        purpose,
    })
}
impl reverie_store::operations::RamClaimScope for InstalledGuard {
    fn assert_ram_claim_scope(
        &self,
        scope: &OperationScope,
    ) -> std::result::Result<(), JournalError> {
        let checked = (|| {
            need(
                matches!(&self.purpose, JournalPurpose::Ram { .. }),
                "RESOURCE_RAM_JOURNAL_PURPOSE_CHANGED",
            )?;
            let gate = self
                .gate
                .upgrade()
                .ok_or(GateError::Refused("RESERVATION_ADMISSION_LOCK_REQUIRED"))?;
            self.assert_purpose(&gate, scope)
        })();
        checked.map_err(|error| JournalError::guard_failure(error.code(), error))
    }
    fn assert_ram_claim_successor(
        &self,
        prior: &Self,
        scope: &OperationScope,
    ) -> std::result::Result<(), JournalError> {
        let checked = (|| {
            let (
                JournalPurpose::Ram {
                    authority: next,
                    active: next_active,
                },
                JournalPurpose::Ram {
                    authority: old,
                    active: old_active,
                },
            ) = (&self.purpose, &prior.purpose)
            else {
                return Err(GateError::Refused("RESOURCE_RAM_JOURNAL_PURPOSE_CHANGED"));
            };
            need(
                Weak::ptr_eq(&self.gate, &prior.gate)
                    && Weak::ptr_eq(next, old)
                    && !Weak::ptr_eq(next_active, old_active),
                "RESOURCE_RAM_JOURNAL_PURPOSE_CHANGED",
            )?;
            let gate = self
                .gate
                .upgrade()
                .ok_or(GateError::Refused("RESERVATION_ADMISSION_LOCK_REQUIRED"))?;
            let active = gate.held(Some(scope))?;
            need(
                next_active
                    .upgrade()
                    .is_some_and(|own| Arc::ptr_eq(&own, &active)),
                "RESOURCE_RAM_JOURNAL_PURPOSE_CHANGED",
            )
        })();
        checked.map_err(|error| JournalError::guard_failure(error.code(), error))
    }
}
impl InstalledGuard {
    fn assert_purpose(&self, gate: &Arc<Inner>, scope: &OperationScope) -> Result<()> {
        let active = match gate.held(Some(scope)) {
            Ok(active) => active,
            // Preserve ordinary guard failure ordering: the original full
            // guard below remains responsible for its missing/wrong scope.
            Err(_) if matches!(&self.purpose, JournalPurpose::Ordinary) => return Ok(()),
            Err(error) => return Err(error),
        };
        if let JournalPurpose::Ram {
            active: original, ..
        } = &self.purpose
        {
            need(
                original
                    .upgrade()
                    .is_some_and(|own| Arc::ptr_eq(&own, &active)),
                "RESOURCE_RAM_JOURNAL_PURPOSE_CHANGED",
            )?;
        }
        let selected = active
            .ram_authority
            .try_lock()
            .map_err(|_| GateError::Refused("RESOURCE_RAM_JOURNAL_UNAVAILABLE"))?
            .clone();
        match (&self.purpose, selected) {
            (JournalPurpose::Ordinary, None) => Ok(()),
            (
                JournalPurpose::Ram {
                    authority: original,
                    ..
                },
                Some(current),
            ) if Weak::ptr_eq(original, &current) => original
                .upgrade()
                .ok_or(GateError::Refused("RESOURCE_RAM_JOURNAL_PURPOSE_CHANGED"))?
                .assert_current(gate, &active),
            _ => Err(GateError::Refused("RESOURCE_RAM_JOURNAL_PURPOSE_CHANGED")),
        }
    }
}
impl ScopeGuard for InstalledGuard {
    fn assert_scope(&self, scope: &OperationScope) -> std::result::Result<(), JournalError> {
        let gate = self
            .gate
            .upgrade()
            .ok_or_else(|| JournalError::refusal("RESERVATION_ADMISSION_LOCK_REQUIRED"))?;
        let checked = (|| {
            self.assert_purpose(&gate, scope)?;
            gate.guard(Some(scope))?;
            gate.assert_policy_ack()?;
            self.assert_purpose(&gate, scope)
        })();
        checked.map_err(|error| JournalError::guard_failure(error.code(), error))
    }
    fn assert_terminal_admission(
        &self,
        scope: &OperationScope,
    ) -> std::result::Result<(), JournalError> {
        let gate = self
            .gate
            .upgrade()
            .ok_or_else(|| JournalError::refusal("RESERVATION_ADMISSION_LOCK_REQUIRED"))?;
        gate.held(Some(scope))
            .map(|_| ())
            .and_then(|()| self.assert_purpose(&gate, scope))
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
        self.assert_no_pool_transition()?;
        self.assert_no_failed_gpu()?;
        let active = self.held(scope)?;
        let inherited = *active
            .deadline
            .lock()
            .map_err(|_| GateError::Refused("RESERVATION_ADMISSION_UNAVAILABLE"))?;
        let (context, config, binding) = self.guard_view(&active, inherited)?;
        let end = context.deadline(inherited)?;
        need(
            domain_digest(config.configuration())? == *binding.domain(),
            "RESERVATION_DOMAIN_CHANGED",
        )?;
        if reservation_control::pending_present(&config)? {
            self.gpu_pending_current(&active)?;
        }
        let image = self
            .source_path
            .as_deref()
            .map(|path| reservation_control::capture_current_image(path, config.configuration()))
            .transpose()?;
        need(
            binding.matches_metadata(&reservation_control::read_marker(&config)?),
            "RESERVATION_BINDING_CHANGED",
        )?;
        let lock = active
            .lock
            .lock()
            .map_err(|_| GateError::Refused("RESERVATION_ADMISSION_UNAVAILABLE"))?;
        reservation_control::guard_layout(&config, &binding, &lock)?;
        drop(lock);
        let rows = context.custody(Some(end))?;
        self.gpu_rows_current(&active, &rows)?;
        need(Instant::now() < end, "RESERVATION_OBSERVATION_DEADLINE")?;
        if let Some(image) = image {
            image.assert_current()?;
        }
        Ok(rows)
    }
    fn guard_view(
        &self,
        active: &Arc<Active>,
        bound: Option<Instant>,
    ) -> Result<(
        ObservationContext,
        Arc<ReservationConfiguration>,
        ControlBinding,
    )> {
        let state = self
            .state
            .lock()
            .map_err(|_| GateError::Refused("RESERVATION_ADMISSION_UNAVAILABLE"))?;
        need(
            state
                .active
                .as_ref()
                .is_some_and(|selected| Arc::ptr_eq(selected, active)),
            "RESERVATION_ADMISSION_LOCK_REQUIRED",
        )?;
        let context = active
            .context
            .lock()
            .map_err(|_| GateError::Refused("RESERVATION_ADMISSION_UNAVAILABLE"))?;
        let (config, binding) = self.installed.bound_resources(&self.binding)?;
        Ok((context.with_inherited(bound), config, binding))
    }
    pub(super) fn store(self: &Arc<Self>) -> Result<OperationStore> {
        // The path comes from the captured validated option. This conversion
        // retains its codepoints through the one native text owner.
        let path = reverie_host::reservation_control::operation_directory(self.config()?.as_ref())?;
        Ok(OperationStore::open(path, installed(self), None)?)
    }
}
