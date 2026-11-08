//! The actual claim's journal/handle move together through outer admissions.
//! No phase can expose the handle, retarget a shared guard or reconstruct it.
use super::*;
use reverie_core::{
    operations::{Effect, JournalDigest},
    revision::ProfileVersion,
};
use reverie_store::operations::{
    RamClaimJournal, RamClaimJournalFailure, SuspendedRamClaimJournal,
};
type Guard = super::guard::InstalledGuard;
pub(super) type SharedJournal = Arc<Mutex<RamPreparationJournal>>;
pub(super) enum RamPreparationJournal {
    Transitioning,
    Active(RamClaimJournal<Guard>),
    Suspended(SuspendedRamClaimJournal<Guard>),
    Failed(Box<RamClaimJournalFailure<Guard>>),
}
impl RamPreparationJournal {
    fn failed(&mut self, owner: Box<RamClaimJournalFailure<Guard>>) -> GateError {
        let cause = GateError::SharedJournal(owner.cause().clone());
        *self = Self::Failed(owner);
        cause
    }
    pub(super) fn retain(
        &mut self,
        store: OperationStore,
        handle: reverie_store::operations::OperationHandle,
        guard: Arc<Guard>,
        scope: OperationScope,
        view: OperationView,
    ) -> Result<()> {
        match RamClaimJournal::retain(store, handle, guard, scope, view) {
            Ok(owner) => {
                *self = Self::Active(owner);
                Ok(())
            }
            Err(owner) => Err(self.failed(owner)),
        }
    }
    pub(super) fn suspend(&mut self) -> Result<()> {
        match std::mem::replace(self, Self::Transitioning) {
            Self::Active(owner) => match owner.suspend() {
                Ok(owner) => {
                    *self = Self::Suspended(owner);
                    Ok(())
                }
                Err(owner) => Err(self.failed(owner)),
            },
            Self::Suspended(owner) => {
                *self = Self::Suspended(owner);
                Ok(())
            }
            Self::Failed(owner) => Err(self.failed(owner)),
            Self::Transitioning => Err(GateError::Refused("RAM_JOURNAL_PHASE_REQUIRED")),
        }
    }
    pub(super) fn resume(&mut self, guard: Arc<Guard>) -> Result<()> {
        match std::mem::replace(self, Self::Transitioning) {
            Self::Suspended(owner) => match owner.resume(guard) {
                Ok(owner) => {
                    *self = Self::Active(owner);
                    Ok(())
                }
                Err(owner) => Err(self.failed(owner)),
            },
            other => {
                *self = other;
                Err(GateError::Refused("RAM_JOURNAL_SUSPENDED_PHASE_REQUIRED"))
            }
        }
    }
    pub(super) fn available(&self) -> bool {
        matches!(self, Self::Active(_) | Self::Suspended(_))
    }
    fn active(&mut self) -> Result<&mut RamClaimJournal<Guard>> {
        match self {
            Self::Active(owner) => Ok(owner),
            Self::Failed(owner) => Err(GateError::SharedJournal(owner.cause().clone())),
            _ => Err(GateError::Refused("RAM_JOURNAL_ACTIVE_PHASE_REQUIRED")),
        }
    }
    pub(super) fn begin_effect(
        &mut self,
        effect: Effect,
        version: ProfileVersion,
    ) -> Result<OperationView> {
        Ok(self.active()?.begin_effect(effect, version)?)
    }
    pub(super) fn record_ack(
        &mut self,
        effect: Effect,
        receipt: JournalDigest,
        version: ProfileVersion,
    ) -> Result<OperationView> {
        Ok(self.active()?.record_ack(effect, receipt, version)?)
    }
    pub(super) fn confirm_preparation(&mut self) -> Result<()> {
        self.active()?.confirm_preparation()?;
        Ok(())
    }
    pub(super) fn close_component(&mut self) -> Result<()> {
        match self {
            Self::Active(owner) => owner.close_component(),
            Self::Suspended(owner) => owner.close_component(),
            Self::Failed(owner) => owner.close_component(),
            Self::Transitioning => return Err(GateError::Refused("RAM_JOURNAL_PHASE_REQUIRED")),
        }
        .map_err(GateError::SharedJournal)
    }
}
impl RetainedPreparation {
    pub(super) fn journal_available(&self) -> bool {
        self.store.is_some()
            || self
                .ram_journal
                .as_ref()
                .is_some_and(|journal| journal.try_lock().is_ok_and(|owner| owner.available()))
    }
    pub(super) fn install_ram_journal(
        &mut self,
        admission: &mut admission::Admission,
    ) -> Result<()> {
        let journal = Arc::new(Mutex::new(RamPreparationJournal::Transitioning));
        self.ram_journal = Some(journal.clone());
        admission.retain_ram_journal(self, journal.clone())?;
        let mut owner = journal
            .lock()
            .map_err(|_| GateError::Refused("RAM_JOURNAL_UNAVAILABLE"))?;
        owner.retain(
            self.store.take().expect("original actual claimed store"),
            self.handle.take().expect("original actual claimed handle"),
            self.scope_guard
                .take()
                .expect("original actual installed guard"),
            self.gate.scope.clone(),
            self.view.clone(),
        )
    }
    pub(super) fn journal_begin_effect(
        &self,
        effect: Effect,
        version: ProfileVersion,
    ) -> Result<OperationView> {
        if let Some(journal) = &self.ram_journal {
            return journal
                .lock()
                .map_err(|_| GateError::Refused("RAM_JOURNAL_UNAVAILABLE"))?
                .begin_effect(effect, version);
        }
        Ok(self
            .store
            .as_ref()
            .expect("live original journal")
            .begin_effect(
                &self.gate.scope,
                self.handle.as_ref().expect("actual original handle"),
                effect,
                version,
            )?)
    }
    pub(super) fn journal_record_ack(
        &self,
        effect: Effect,
        receipt: JournalDigest,
        version: ProfileVersion,
    ) -> Result<OperationView> {
        if let Some(journal) = &self.ram_journal {
            return journal
                .lock()
                .map_err(|_| GateError::Refused("RAM_JOURNAL_UNAVAILABLE"))?
                .record_ack(effect, receipt, version);
        }
        Ok(self
            .store
            .as_ref()
            .expect("live original journal")
            .record_ack(
                &self.gate.scope,
                self.handle.as_ref().expect("actual original handle"),
                effect,
                receipt,
                version,
            )?)
    }
    pub(super) fn journal_confirm_preparation(&self) -> Result<()> {
        if let Some(journal) = &self.ram_journal {
            return journal
                .lock()
                .map_err(|_| GateError::Refused("RAM_JOURNAL_UNAVAILABLE"))?
                .confirm_preparation();
        }
        self.store
            .as_ref()
            .expect("live original journal")
            .confirm_preparation(&self.gate.scope, &self.view)?;
        Ok(())
    }
}
