//! Existing private durable RAM claims and phase journal, without native effects.
//! Trusted installation supplies guards/observation, never a wire callback.
mod claim;
mod completion;
mod confirmation;
mod draft;
mod error;
mod io;
mod ram_claim;
pub use ram_claim::{
    AbortedRamClaimJournal, RamClaimJournal, RamClaimJournalFailure, RamClaimScope,
    SuspendedRamClaimJournal,
};
mod terminal;
mod transition;
use crate::private_fs::{self, CloseRole, Directory, Stamp};
pub use completion::NativeCompletionProof;
pub use draft::{
    DraftObservation, DraftObserver, DraftReferences, DraftSnapshot, allocate_draft_references,
    allocate_profile_target,
};
pub use error::{JournalError, Result};
use error::{finalized, need};
use reverie_core::operations::*;
use std::{
    collections::BTreeMap,
    fs::File,
    path::Path,
    sync::{Arc, Mutex},
};
pub use terminal::TerminalJournalStamp;

/// Existing settlement-history directory observation. Drains every entry/error
/// and checked-closes the DIR, retaining the native-order prefix through the
/// first count violation. No lock, scope,
/// journal validation or native-effect authority is conferred by these bytes.
pub fn settlement_directory_names(directory: &Path) -> Result<Vec<Vec<u8>>> {
    Ok(private_fs::settlement_directory_names(directory)?)
}
/// Fixed preparation-policy temporary purpose, using the existing sole native
/// CSPRNG owner. The resulting name is DATA, not directory/file custody.
pub fn allocate_policy_temporary_name() -> Result<String> {
    Ok(private_fs::random_name(".resource-preparing-")?)
}
/// Adjacent owner-GPU publication uses the same sole CSPRNG owner; the name is
/// not file custody, an atomic CAS or permission to replace any existing file.
pub fn allocate_gpu_temporary_name() -> Result<String> {
    Ok(private_fs::random_name(".gpu-")?)
}

/// Must be fixed by trusted service installation and retain its live owner scope
/// and outer native-admission guard. Directory custody is never authorization.
pub trait ScopeGuard: Send + Sync {
    fn assert_scope(&self, scope: &OperationScope) -> Result<()>;
    /// Fixed read-only terminal-reader seam. A production gate may assert its
    /// actual held admission and scope without introducing fresh engine I/O at
    /// this phase. Ordinary readers and every write still call assert_scope.
    fn assert_terminal_admission(&self, scope: &OperationScope) -> Result<()> {
        self.assert_scope(scope)
    }
}
/// Repeated capacity checks do not replace the native host admission transaction.
pub trait CapacityObserver: Send + Sync {
    fn observe(
        &self,
        scope: &OperationScope,
        pool: &JournalId,
        employee: &JournalId,
    ) -> Result<CapacityObservation>;
}

/// Process-local, nonserializable claim reference, not a native effect permit.
pub struct OperationHandle {
    id: JournalId,
    token: Arc<()>,
}
impl OperationHandle {
    pub fn operation_id(&self) -> &JournalId {
        &self.id
    }
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OperationView {
    record: Operation,
    orphaned: bool,
}
impl OperationView {
    /// Canonical retained record; presentation state can be orphaned separately.
    pub fn record(&self) -> &Operation {
        &self.record
    }
    pub fn state(&self) -> OperationState {
        if self.orphaned {
            OperationState::RecoveryRequired
        } else {
            self.record.data().state
        }
    }
    pub fn reason(&self) -> Option<&str> {
        if self.orphaned {
            Some("ORPHANED_CLAIM_REQUIRES_PROTECTED_RECONCILIATION")
        } else {
            self.record
                .data()
                .reason
                .as_ref()
                .map(RecoveryReason::as_str)
        }
    }
    pub fn verified(&self) -> bool {
        false
    }
    pub fn retry_allowed(&self) -> bool {
        false
    }
    pub fn reservation_retained(&self) -> bool {
        true
    }
}
#[derive(Default)]
pub struct ClaimSelection {
    pub reserved_sid: Option<JournalId>,
    pub operation_id: Option<JournalId>,
    pub reservation_id: Option<JournalId>,
}
pub struct OperationStore {
    inner: Mutex<Inner>,
    guard: Arc<dyn ScopeGuard>,
    observer: Option<Arc<dyn CapacityObserver>>,
    draft_observer: Option<Arc<dyn DraftObserver>>,
    #[cfg(test)]
    identity: Arc<()>,
}
struct Inner {
    directory: Option<Directory>,
    leases: BTreeMap<JournalId, Arc<()>>,
}
impl Inner {
    fn directory(&self) -> Result<&Directory> {
        self.directory
            .as_ref()
            .ok_or(JournalError::refusal("STORE_CLOSED"))
    }
    fn view(&self, record: &Operation) -> OperationView {
        OperationView {
            record: record.clone(),
            orphaned: !self.leases.contains_key(&record.data().id)
                && record.data().state != OperationState::RecoveryRequired,
        }
    }
    fn owns(&self, handle: &OperationHandle) -> bool {
        self.leases
            .get(&handle.id)
            .is_some_and(|token| Arc::ptr_eq(token, &handle.token))
    }
}
struct Context {
    attempted: bool,
    expected: Option<OperationDocument>,
    signature: Option<Stamp>,
}
impl Context {
    fn initial(
        &mut self,
        directory: &Directory,
        initialize: bool,
    ) -> Result<Option<OperationDocument>> {
        if initialize {
            need(
                directory.only_lock_leaf("operations.lock")?,
                "NOT_EMPTY_OR_INITIALIZED",
            )?;
            return Ok(None);
        }
        let loaded = io::load(directory)?;
        self.signature = Some(loaded.stamp);
        Ok(Some(loaded.document))
    }
}
impl OperationStore {
    /// Open an existing current-euid-owned mode0700 directory; never initialize
    /// or treat an absent/corrupt journal as a successful empty observation.
    pub fn open(
        path: impl AsRef<Path>,
        guard: Arc<dyn ScopeGuard>,
        observer: Option<Arc<dyn CapacityObserver>>,
    ) -> Result<Self> {
        Ok(Self {
            inner: Mutex::new(Inner {
                directory: Some(Directory::open(path.as_ref())?),
                leases: BTreeMap::new(),
            }),
            guard,
            observer,
            draft_observer: None,
            #[cfg(test)]
            identity: Arc::new(()),
        })
    }
    /// Revoke local handles and close the directory once. The application must
    /// check this result before acknowledging its complete outer transaction.
    pub fn close(&self) -> Result<()> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| JournalError::refusal("LEDGER_UNAVAILABLE"))?;
        inner.leases.clear();
        match inner.directory.take() {
            Some(directory) => Ok(directory.close()?),
            None => Ok(()),
        }
    }
    pub fn initialize(&self, scope: &OperationScope) -> Result<()> {
        self.locked(scope, true, None, |inner, _, context, lock| {
            self.commit(
                inner,
                lock,
                scope,
                &OperationDocument::empty(),
                context,
                None,
            )
        })
    }
    /// Protected installing-service data for admission/reconciliation. This is
    /// not a scoped browser response or authority to inspect another owner.
    pub fn snapshot(&self, scope: &OperationScope) -> Result<OperationDocument> {
        self.locked(scope, false, None, |_, current, _, _| {
            Ok(current.expect("existing read"))
        })
    }
    pub fn lookup(&self, scope: &OperationScope, key: &JournalId) -> Result<Option<OperationView>> {
        self.locked(scope, false, None, |inner, current, _, _| {
            Ok(current
                .expect("existing read")
                .operations()
                .values()
                .find(|op| op.data().scope == *scope && op.data().idempotency_key == *key)
                .map(|op| inner.view(op)))
        })
    }
    fn locked<T>(
        &self,
        scope: &OperationScope,
        initialize: bool,
        revoke: Option<&OperationHandle>,
        action: impl FnOnce(&mut Inner, Option<OperationDocument>, &mut Context, &File) -> Result<T>,
    ) -> Result<T> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| JournalError::refusal("LEDGER_UNAVAILABLE"))?;
        let mut context = Context {
            attempted: false,
            expected: None,
            signature: None,
        };
        let result = (|| {
            inner.directory()?.check()?;
            self.guard.assert_scope(scope)?;
            let lock = inner.directory()?.lock_named("operations.lock")?;
            let primary = (|| {
                inner.directory()?.check()?;
                inner
                    .directory()?
                    .check_lock_named(&lock, "operations.lock")?;
                let current = context.initial(inner.directory()?, initialize)?;
                context.expected = current.clone();
                let result = action(&mut inner, current, &mut context, &lock)?;
                self.guard.assert_scope(scope)?;
                inner.directory()?.check()?;
                inner
                    .directory()?
                    .check_lock_named(&lock, "operations.lock")?;
                let final_read = io::load(inner.directory()?)?;
                need(
                    context.expected.as_ref() == Some(&final_read.document)
                        && context.signature.as_ref() == Some(&final_read.stamp),
                    "FINAL_JOURNAL_CHANGED",
                )?;
                Ok(result)
            })();
            let closed = private_fs::close(lock, CloseRole::Lock, inner.directory()?.path())
                .map_err(Into::into);
            finalized(primary, closed)
        })();
        if let Some(handle) = revoke
            && inner.owns(handle)
        {
            inner.leases.remove(&handle.id);
        }
        if context.attempted && result.is_err() {
            inner.leases.clear();
            result.map_err(JournalError::uncertain)
        } else {
            result
        }
    }
}
#[cfg(test)]
mod tests;
