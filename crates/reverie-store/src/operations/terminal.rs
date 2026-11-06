use super::*;
use crate::StoreError;
use std::path::PathBuf;
/// Opaque original journal generation data. This retains no descriptor, lock,
/// completion proof, reservation credit, owner grant or native effect permit.
pub struct TerminalJournalStamp {
    path: PathBuf,
    stamp: Stamp,
}
enum TerminalSelection<'a> {
    Exact(&'a OperationDocument),
    Preparation(&'a OperationView),
    NativeStart(&'a OperationView),
}
impl TerminalSelection<'_> {
    fn assert_document(&self, document: &OperationDocument) -> Result<()> {
        match self {
            Self::Exact(expected) => need(document == *expected, "RESERVATION_CLAIM_CHANGED"),
            Self::Preparation(view) => {
                let expected = view.record();
                need(
                    document
                        .operations()
                        .get(&expected.data().id)
                        .is_some_and(|op| {
                            op == expected
                                && matches!(
                                    op.data().state,
                                    OperationState::Preparing | OperationState::Prepared
                                )
                        }),
                    "RESOURCE_PREPARATION_CLAIM_CHANGED",
                )
            }
            Self::NativeStart(view) => {
                let expected = view.record();
                need(
                    document
                        .operations()
                        .get(&expected.data().id)
                        .is_some_and(|operation| {
                            operation == expected
                                && matches!(
                                    (operation.data().state, operation.data().version.get()),
                                    (OperationState::Prepared, 3) | (OperationState::Starting, 4)
                                )
                        }),
                    "RESOURCE_NATIVE_CLAIM_CHANGED",
                )
            }
        }
    }
}
impl TerminalJournalStamp {
    /// Only a named metadata observation; the actual gate retains admission.
    /// No fallible descriptor finalizer follows this check.
    pub fn assert_named_current(&self) -> Result<()> {
        self.assert_current("RESERVATION_CLAIM_CHANGED")
    }
    pub fn assert_preparation_named_current(&self) -> Result<()> {
        self.assert_current("RESOURCE_PREPARATION_CLAIM_CHANGED")
    }
    pub fn assert_native_start_named_current(&self) -> Result<()> {
        self.assert_current("RESOURCE_NATIVE_CLAIM_CHANGED")
    }
    fn assert_current(&self, code: &'static str) -> Result<()> {
        let current = std::fs::symlink_metadata(&self.path).map_err(StoreError::io)?;
        need(
            self.stamp.same_generation(&Stamp::from_metadata(&current)),
            code,
        )
    }
}
impl OperationStore {
    /// Consume this fresh terminal reader and close its lock AND store before
    /// returning the original named stamp. Both failures remain visible. The
    /// application then performs its last native guard and final metadata
    /// fences; it must not insert another native reader after those fences.
    pub fn into_exact_terminal_stamp(
        self,
        scope: &OperationScope,
        expected: &OperationDocument,
    ) -> Result<TerminalJournalStamp> {
        let read = self.read_terminal(scope, TerminalSelection::Exact(expected));
        let closed = self.close();
        finalized(read.map(|(_, stamp)| stamp), closed)
    }
    /// Consuming fixed preparation reader. Checks only the exact selected
    /// operation/allowed phase, then closes its actual flock and owned store.
    /// It returns no handle, completion proof, credit or launch permission.
    pub fn into_preparation_terminal_stamp(
        self,
        scope: &OperationScope,
        expected: &OperationView,
    ) -> Result<TerminalJournalStamp> {
        let read = self.read_terminal(scope, TerminalSelection::Preparation(expected));
        finalized(read.map(|(_, stamp)| stamp), self.close())
    }
    /// Original native _document read: one selected operation and full current
    /// document, with both fresh lock/store closed BEFORE native observations.
    /// The returned stamp/data cannot mint a handle, grant, retry or completion.
    pub fn into_native_start_snapshot(
        self,
        scope: &OperationScope,
        expected: &OperationView,
    ) -> Result<(OperationDocument, TerminalJournalStamp)> {
        let read = self.read_terminal(scope, TerminalSelection::NativeStart(expected));
        finalized(read, self.close())
    }
    fn read_terminal(
        &self,
        scope: &OperationScope,
        expected: TerminalSelection<'_>,
    ) -> Result<(OperationDocument, TerminalJournalStamp)> {
        let inner = self
            .inner
            .lock()
            .map_err(|_| JournalError::refusal("LEDGER_UNAVAILABLE"))?;
        let directory = inner.directory()?;
        directory.check()?;
        self.guard.assert_terminal_admission(scope)?;
        let lock = directory.lock_named("operations.lock")?;
        let primary = (|| {
            directory.check()?;
            directory.check_lock_named(&lock, "operations.lock")?;
            let loaded = io::load(directory)?;
            expected.assert_document(&loaded.document)?;
            directory.check()?;
            directory.check_lock_named(&lock, "operations.lock")?;
            Ok((
                loaded.document,
                TerminalJournalStamp {
                    path: directory.path().join("operations.json"),
                    stamp: loaded.stamp,
                },
            ))
        })();
        let closed = private_fs::close(lock, CloseRole::Lock, directory.path()).map_err(Into::into);
        finalized(primary, closed)
    }
}
