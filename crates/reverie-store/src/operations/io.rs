use super::*;
use reverie_contracts::operations_v1::{self, MAX_BYTES};
pub(super) struct Loaded {
    pub document: OperationDocument,
    pub stamp: Stamp,
}
pub(super) fn load(directory: &Directory) -> Result<Loaded> {
    let mut file = directory
        .read_file("operations.json")?
        .ok_or(JournalError::refusal("LEDGER_UNAVAILABLE"))?;
    let result = (|| {
        let before = private_fs::private_stamp(&file)?;
        let raw = private_fs::read_bounded(&mut file, MAX_BYTES)?;
        #[cfg(test)]
        crate::faults::hit(crate::faults::Point::AfterDataRead, directory.path())?;
        need(
            private_fs::private_stamp(&file)? == before,
            "JOURNAL_CHANGED",
        )?;
        need(
            directory
                .stamp("operations.json")?
                .is_some_and(|named| named.same_inode(&before)),
            "JOURNAL_REBOUND",
        )?;
        Ok(Loaded {
            document: operations_v1::decode(&raw)?,
            stamp: before,
        })
    })();
    finalized(
        result,
        private_fs::close(file, CloseRole::Data, directory.path()).map_err(Into::into),
    )
}
impl OperationStore {
    pub(super) fn commit(
        &self,
        inner: &Inner,
        lock: &File,
        scope: &OperationScope,
        document: &OperationDocument,
        context: &mut Context,
        fence: Option<&dyn Fn() -> Result<()>>,
    ) -> Result<()> {
        let raw = operations_v1::encode(document)?;
        self.current(inner, lock, scope, context)?;
        let directory = inner.directory()?;
        let temporary = crate::transaction::prepare(directory, &raw, MAX_BYTES, ".operation-")?;
        #[cfg(test)]
        let hook = crate::faults::hit(
            crate::faults::Point::AfterTemporaryPrepared,
            directory.path(),
        )
        .map_err(Into::into);
        #[cfg(not(test))]
        let hook: Result<()> = Ok(());
        let primary = hook.and_then(|()| {
            self.current(inner, lock, scope, context)?;
            temporary.check(directory)?;
            if let Some(fence) = fence {
                fence()?;
            }
            #[cfg(test)]
            crate::faults::hit(crate::faults::Point::BeforePublication, directory.path())?;
            context.attempted = true;
            directory.publish_named(
                &temporary.name,
                "operations.json",
                context.expected.is_none(),
            )?;
            directory.sync()?;
            directory.check()?;
            let actual = load(directory)?;
            need(actual.document == *document, "COMMITTED_JOURNAL_CHANGED")?;
            need(actual.stamp == temporary.stamp()?, "JOURNAL_REBOUND")?;
            context.expected = Some(document.clone());
            context.signature = Some(actual.stamp);
            if let Some(fence) = fence {
                fence()?;
            }
            Ok(())
        });
        let cleaned = temporary.cleanup(directory).map_err(Into::into);
        #[cfg(test)]
        let cleaned = finalized(
            cleaned,
            crate::faults::hit(
                crate::faults::Point::AfterTemporaryCleanup,
                directory.path(),
            )
            .map_err(Into::into),
        );
        finalized(primary, cleaned)
    }
    fn current(
        &self,
        inner: &Inner,
        lock: &File,
        scope: &OperationScope,
        context: &Context,
    ) -> Result<()> {
        self.guard.assert_scope(scope)?;
        let directory = inner.directory()?;
        directory.check()?;
        directory.check_lock_named(lock, "operations.lock")?;
        if let Some(expected) = &context.expected {
            let current = load(directory)?;
            need(
                current.document == *expected && Some(current.stamp) == context.signature,
                "STALE_JOURNAL",
            )?;
        }
        Ok(())
    }
}
