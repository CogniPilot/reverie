use super::*;
use crate::StoreError;
use std::path::PathBuf;
/// Opaque original journal generation data. This retains no descriptor, lock,
/// completion proof, reservation credit, owner grant or native effect permit.
pub struct TerminalJournalStamp {
    path: PathBuf,
    stamp: Stamp,
}
impl TerminalJournalStamp {
    /// Only a named metadata observation; the actual gate retains admission.
    /// No fallible descriptor finalizer follows this check.
    pub fn assert_named_current(&self) -> Result<()> {
        let current = std::fs::symlink_metadata(&self.path).map_err(StoreError::io)?;
        need(
            self.stamp.same_generation(&Stamp::from_metadata(&current)),
            "RESERVATION_CLAIM_CHANGED",
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
        let read = self.read_exact_terminal(scope, expected);
        let closed = self.close();
        finalized(read, closed)
    }
    fn read_exact_terminal(
        &self,
        scope: &OperationScope,
        expected: &OperationDocument,
    ) -> Result<TerminalJournalStamp> {
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
            need(&loaded.document == expected, "RESERVATION_CLAIM_CHANGED")?;
            directory.check()?;
            directory.check_lock_named(&lock, "operations.lock")?;
            Ok(TerminalJournalStamp {
                path: directory.path().join("operations.json"),
                stamp: loaded.stamp,
            })
        })();
        let closed = private_fs::close(lock, CloseRole::Lock, directory.path()).map_err(Into::into);
        finalized(primary, closed)
    }
}
