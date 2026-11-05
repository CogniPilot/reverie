use crate::error::{Result, StoreError, StoreFault, finalized, need};
use crate::private_fs::{self, CloseRole, Directory, Stamp};
use crate::profiles::{Loaded, MAX_BYTES, ProfileStore};
use reverie_contracts::profiles_v1;
use reverie_core::profiles::{ProfileDocument, ProfilePutIntent};
use std::fs::File;

struct Temporary {
    name: String,
    stamp: Stamp,
    anchor: File,
}
fn prepare(directory: &Directory, bytes: &[u8]) -> Result<Temporary> {
    let name = private_fs::random_temporary_name()?;
    let mut writer = directory.create_file(&name)?;
    let initial = match initial_stamp(&writer, directory) {
        Ok(stamp) => stamp,
        Err(error) => {
            return finalized(
                Err(StoreError::PreparationRetained {
                    cause: Box::new(error),
                }),
                private_fs::close(writer, CloseRole::Temporary, directory.path()),
            );
        }
    };
    let anchor = match pin(directory, &name, &initial) {
        Ok(anchor) => anchor,
        Err(error) => return failed_unanchored(directory, &name, &initial, writer, error),
    };
    let mut temporary = Temporary {
        name,
        stamp: initial,
        anchor,
    };
    let write = private_fs::write_all(&mut writer, bytes, directory.path());
    let verified = write.and_then(|()| verify_prepared(&mut writer, bytes));
    let closed = private_fs::close(writer, CloseRole::Temporary, directory.path());
    let result = finalized(verified, closed);
    match result {
        Ok(stamp) => {
            temporary.stamp = stamp;
            Ok(temporary)
        }
        Err(error) => {
            let cleanup = temporary.cleanup(directory);
            finalized(Err(error), cleanup)
        }
    }
}
fn initial_stamp(writer: &File, directory: &Directory) -> Result<Stamp> {
    #[cfg(test)]
    crate::faults::hit(
        crate::faults::Point::InitialTemporaryMetadata,
        directory.path(),
    )?;
    #[cfg(not(test))]
    let _ = directory;
    private_fs::private_stamp(writer)
}
fn pin(directory: &Directory, name: &str, initial: &Stamp) -> Result<File> {
    #[cfg(test)]
    crate::faults::hit(crate::faults::Point::BeforeTemporaryPin, directory.path())?;
    let anchor = directory.pin_file(name)?;
    let valid = private_fs::private_stamp(&anchor)
        .and_then(|stamp| need(stamp.same_inode(initial), StoreFault::TemporaryRebound));
    if let Err(error) = valid {
        return finalized(
            Err(error),
            private_fs::close(anchor, CloseRole::TemporaryAnchor, directory.path()),
        );
    }
    Ok(anchor)
}
fn failed_unanchored(
    directory: &Directory,
    name: &str,
    initial: &Stamp,
    writer: File,
    error: StoreError,
) -> Result<Temporary> {
    // The creator fd pins this inode until cleanup; never unlink a replacement.
    let cleaned = directory.remove_temporary(name, initial);
    let closed = private_fs::close(writer, CloseRole::Temporary, directory.path());
    finalized(finalized(Err(error), cleaned), closed)
}
fn verify_prepared(file: &mut File, bytes: &[u8]) -> Result<Stamp> {
    let before = private_fs::private_stamp(file)?;
    private_fs::rewind(file)?;
    let actual = private_fs::read_bounded(file, MAX_BYTES)?;
    need(
        actual == bytes && private_fs::private_stamp(file)? == before,
        StoreFault::Changed,
    )?;
    Ok(before)
}
impl Temporary {
    fn check(&self, directory: &Directory) -> Result<()> {
        need(
            private_fs::private_stamp(&self.anchor)? == self.stamp,
            StoreFault::TemporaryRebound,
        )?;
        need(
            directory.stamp(&self.name)?.as_ref() == Some(&self.stamp),
            StoreFault::TemporaryRebound,
        )
    }
    fn cleanup(self, directory: &Directory) -> Result<()> {
        let removed = directory.remove_temporary(&self.name, &self.stamp);
        let closed = private_fs::close(self.anchor, CloseRole::TemporaryAnchor, directory.path());
        finalized(removed, closed)
    }
}
fn unchanged(store: &ProfileStore, current: &Loaded) -> Result<()> {
    let fresh = store.load()?;
    need(
        fresh.stamp == current.stamp && fresh.raw == current.raw,
        StoreFault::Changed,
    )
}
fn commit(
    store: &ProfileStore,
    lock: &File,
    current: &Loaded,
    document: &ProfileDocument,
    attempted: &mut bool,
) -> Result<Stamp> {
    let bytes = profiles_v1::encode(document).map_err(StoreError::Codec)?;
    let temporary = prepare(&store.directory, &bytes)?;
    #[cfg(test)]
    let hook = crate::faults::hit(
        crate::faults::Point::AfterTemporaryPrepared,
        store.directory.path(),
    );
    #[cfg(not(test))]
    let hook = Ok(());
    let outcome = hook.and_then(|()| publish(store, lock, current, &temporary, &bytes, attempted));
    let cleanup = temporary.cleanup(&store.directory);
    #[cfg(test)]
    let cleanup = finalized(
        cleanup,
        crate::faults::hit(
            crate::faults::Point::AfterTemporaryCleanup,
            store.directory.path(),
        ),
    );
    finalized(outcome, cleanup)
}
fn publish(
    store: &ProfileStore,
    lock: &File,
    current: &Loaded,
    temporary: &Temporary,
    bytes: &[u8],
    attempted: &mut bool,
) -> Result<Stamp> {
    #[cfg(test)]
    crate::faults::hit(
        crate::faults::Point::BeforePublication,
        store.directory.path(),
    )?;
    store.directory.check()?;
    store.directory.check_lock(lock)?;
    unchanged(store, current)?;
    temporary.check(&store.directory)?;
    // Includes a syscall that installs data but loses its acknowledgement.
    *attempted = true;
    store
        .directory
        .publish(&temporary.name, current.stamp.is_none())?;
    store.directory.sync()?;
    store.directory.check()?;
    store.directory.check_lock(lock)?;
    let actual = store.load()?;
    need(actual.raw == bytes, StoreFault::Changed)?;
    let stamp = actual
        .stamp
        .ok_or(StoreError::Refused(StoreFault::Changed))?;
    need(
        stamp == private_fs::private_stamp(&temporary.anchor)?,
        StoreFault::FileRebound,
    )?;
    store.directory.check()?;
    Ok(stamp)
}
pub(crate) fn put(store: &ProfileStore, intent: &ProfilePutIntent) -> Result<ProfileDocument> {
    store.directory.check()?;
    let lock = store.directory.lock()?;
    let mut attempted = false;
    let result = (|| {
        let current = store.load()?;
        let document = current
            .document
            .apply(intent)
            .map_err(StoreError::Profile)?;
        let committed = commit(store, &lock, &current, &document, &mut attempted)?;
        store.directory.check()?;
        store.directory.check_lock(&lock)?;
        need(
            store.directory.stamp("profiles.json")?.as_ref() == Some(&committed),
            StoreFault::Changed,
        )?;
        Ok(document)
    })();
    let closed = private_fs::close(lock, CloseRole::Lock, store.directory.path());
    let result = finalized(result, closed);
    if attempted {
        result.map_err(StoreError::uncertain)
    } else {
        result
    }
}
