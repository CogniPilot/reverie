use super::*;
use reverie_host::worker_storage::StorageOwnershipKind;
pub(super) fn fence(
    claim: &StorageClaim,
    context: &ObservationContext,
) -> StopResult<(Arc<StorageRegistry>, Arc<()>)> {
    let ClaimState::Registered {
        registry,
        identity,
        paths,
        ..
    } = &claim.state
    else {
        return Err(refused("RAM_STOPPED_EMPLOYEE_LEASE_REQUIRED"));
    };
    if paths.kind() != StorageKind::Employee {
        return Err(refused("RAM_STOPPED_EMPLOYEE_LEASE_REQUIRED"));
    }
    context
        .assert_worker_runtime(&registry.runtime)
        .map_err(native)?;
    Ok((registry.clone(), identity.clone()))
}
pub(super) fn check_direct(
    entries: &[Entry],
    identity: &Arc<()>,
    claim: &StorageClaim,
    context: &ObservationContext,
    runtime: &WorkerRuntime,
) -> StopResult<usize> {
    let index = entries
        .iter()
        .position(|entry| Arc::ptr_eq(&entry.identity, identity))
        .ok_or_else(|| refused("RAM_STOPPED_SOURCE_ENTRY_CHANGED"))?;
    let entry = &entries[index];
    if !entry.writer_checked || &entry.paths != claim.paths() {
        return Err(refused("RAM_STOPPED_SOURCE_ENTRY_CHANGED"));
    }
    let EntryOwner::Direct(owner) = &entry.owner else {
        return Err(refused("RAM_STOPPED_SOURCE_NOT_DIRECT"));
    };
    if owner.ownership_kind() != StorageOwnershipKind::HeldLease {
        return Err(refused("RAM_STOPPED_EMPLOYEE_LEASE_REQUIRED"));
    }
    owner
        .assert_binding(runtime, context.configuration(), claim.paths().session())
        .map_err(storage)?;
    Ok(index)
}
pub(super) fn check_record(
    entries: &[Entry],
    identity: &Arc<()>,
    expected: &Arc<Mutex<Record>>,
) -> StopResult<usize> {
    let index = entries
        .iter()
        .position(|entry| Arc::ptr_eq(&entry.identity, identity))
        .ok_or_else(|| refused("RAM_STOPPED_SOURCE_ENTRY_CHANGED"))?;
    if !matches!(&entries[index].owner, EntryOwner::StoppedRam(actual) if Arc::ptr_eq(actual, expected))
    {
        return Err(refused("RAM_STOPPED_SOURCE_ENTRY_CHANGED"));
    }
    Ok(index)
}
impl StoppedRamSource {
    /// Pure one-way custody transfer before ANY durable claim attempt. The
    /// retained type exposes no unclaimed restore method or raw lease.
    pub(crate) fn retain_for_claim(
        self,
    ) -> std::result::Result<RetainedStoppedRamSource, Box<StoppedRamAdvanceFailure>> {
        let result = self.advance();
        match result {
            Ok(()) => Ok(RetainedStoppedRamSource { source: self }),
            Err(cause) => Err(Box::new(StoppedRamAdvanceFailure { owner: self, cause })),
        }
    }
    fn advance(&self) -> StopResult<()> {
        self.assert_entry()?;
        let mut record = self
            .record
            .try_lock()
            .map_err(|_| refused("RAM_STOPPED_SOURCE_IN_USE_OR_POISONED"))?;
        let held = record.held()?;
        if !matches!(held.phase, Phase::Unclaimed) {
            return Err(refused("RAM_STOPPED_SOURCE_ALREADY_RETAINED"));
        }
        held.observed()?;
        held.phase = Phase::Retained;
        Ok(())
    }
    /// Restoration returns custody to Direct, never closes the physical lease
    /// or supplies stopped/absence/capacity permission. A known body failure
    /// remains in the returned report; uncertain native cleanup retains self.
    pub(crate) fn restore_unclaimed(
        mut self,
        end: Instant,
    ) -> std::result::Result<RestoredStoppedRamSource, Box<StoppedRamRestoreFailure>> {
        match self.restore(end) {
            Ok(primary) => Ok(RestoredStoppedRamSource {
                claim: self.claim.take().expect("same held claim"),
                primary,
            }),
            Err(cause) => Err(Box::new(StoppedRamRestoreFailure { owner: self, cause })),
        }
    }
    fn restore(&self, end: Instant) -> StopResult<Option<Arc<StoppedRamError>>> {
        self.assert_entry()?;
        let mut record = self
            .record
            .try_lock()
            .map_err(|_| refused("RAM_STOPPED_SOURCE_IN_USE_OR_POISONED"))?;
        let held = record.held()?;
        if !matches!(held.phase, Phase::Unclaimed) {
            return Err(refused("RAM_STOPPED_SOURCE_ALREADY_RETAINED"));
        }
        let primary = held.primary();
        let cleanup = (|| {
            held.context.settle_stopped_ram(end).map_err(native)?;
            held.current(&self.registry.runtime)
        })();
        if let Err(cleanup) = cleanup {
            let error = cleanup_cause(primary.as_ref(), cleanup);
            held.outcome = Outcome::Failed(error.clone());
            return Err(error);
        }
        let mut entries = match self.registry.lock(self.registry.runtime.stop_deadline()) {
            Ok(entries) => entries,
            Err(error) => {
                let error = cleanup_cause(primary.as_ref(), storage(error));
                held.outcome = Outcome::Failed(error.clone());
                return Err(error);
            }
        };
        let index = match check_record(&entries, &self.identity, &self.record) {
            Ok(index) => index,
            Err(error) => {
                let error = cleanup_cause(primary.as_ref(), error);
                held.outcome = Outcome::Failed(error.clone());
                return Err(error);
            }
        };
        let Held { owner, .. } = record.held.take().expect("checked same held source");
        // All fallible work precedes this move; old record aliases are consumed.
        entries[index].owner = EntryOwner::Direct(owner);
        Ok(primary)
    }
}
fn cleanup_cause(
    primary: Option<&Arc<StoppedRamError>>,
    cleanup: Arc<StoppedRamError>,
) -> Arc<StoppedRamError> {
    primary.map_or_else(
        || cleanup.clone(),
        |primary| {
            Arc::new(StoppedRamError::Finalization {
                primary: primary.clone(),
                cleanup: cleanup.clone(),
            })
        },
    )
}
