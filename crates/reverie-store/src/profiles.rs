//! Canonical employee resource profiles, using the existing v1 files and lock.
//!
//! Directory custody is not owner or admission authority. The application must
//! keep its existing authorization and native admission checks around these calls.
use crate::error::{Result, StoreError, StoreFault, finalized, need};
use crate::private_fs::{self, CloseRole, Directory, Stamp};
use crate::transaction;
use reverie_contracts::profiles_v1;
use reverie_core::profiles::{ProfileDocument, ProfilePutIntent};
use std::fs::File;
use std::path::Path;

pub(crate) use profiles_v1::MAX_BYTES;
pub(crate) struct Loaded {
    pub(crate) document: ProfileDocument,
    pub(crate) raw: Vec<u8>,
    pub(crate) stamp: Option<Stamp>,
}

/// Whether this one stable observation found the existing profile document.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProfilePresence {
    Missing,
    Present,
}
/// A data observation, not an admission, ownership or native-effect capability.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProfileObservation {
    document: ProfileDocument,
    presence: ProfilePresence,
}
impl ProfileObservation {
    pub fn document(&self) -> &ProfileDocument {
        &self.document
    }
    pub fn into_document(self) -> ProfileDocument {
        self.document
    }
    pub fn presence(&self) -> ProfilePresence {
        self.presence
    }
}

/// An already existing private profile directory. Opening never initializes it.
pub struct ProfileStore {
    pub(crate) directory: Directory,
}
impl ProfileStore {
    /// The selected directory must already exist, with current-euid ownership and mode0700.
    pub fn open(directory: impl AsRef<Path>) -> Result<Self> {
        Ok(Self {
            directory: Directory::open(directory.as_ref())?,
        })
    }
    /// A nonlocking observation that creates no lock or store file.
    ///
    /// It does not prove an admission transaction or authorize a write. B's
    /// existing outer admission guard must supply that consistency/authority.
    pub fn read_existing(&self) -> Result<ProfileDocument> {
        Ok(self.observe_existing()?.into_document())
    }
    /// Read without file creation while retaining missing-versus-present-empty.
    /// This does not establish the application's external admission guard.
    pub fn observe_existing(&self) -> Result<ProfileObservation> {
        let loaded = self.load()?;
        Ok(ProfileObservation {
            document: loaded.document,
            presence: if loaded.stamp.is_some() {
                ProfilePresence::Present
            } else {
                ProfilePresence::Missing
            },
        })
    }
    /// A locked snapshot; a missing document is the legacy empty revisionzero.
    /// The existing profiles.lock may be created, exactly as in the legacy store.
    pub fn snapshot(&self) -> Result<ProfileDocument> {
        self.directory.check()?;
        let lock = self.directory.lock()?;
        let result = self.load().map(|loaded| loaded.document);
        self.finish_read(lock, result)
    }
    /// Commit a checked revision/version/binding-CAS intent to the existing store.
    /// No owner grant or native effect permission is created or consumed here.
    pub fn put(&self, intent: &ProfilePutIntent) -> Result<ProfileDocument> {
        transaction::put(self, intent)
    }
    /// Checked finalization for an application that explicitly closes its store.
    /// Close failure is conservative: inspect state, never assume prior writes rolledback.
    pub fn close(self) -> Result<()> {
        self.directory.close().map_err(StoreError::uncertain)
    }
    fn finish_read(&self, lock: File, result: Result<ProfileDocument>) -> Result<ProfileDocument> {
        let final_check = self
            .directory
            .check()
            .and_then(|()| self.directory.check_lock(&lock));
        let closed = private_fs::close(lock, CloseRole::Lock, self.directory.path());
        finalized(finalized(result, final_check), closed)
    }
    pub(crate) fn load(&self) -> Result<Loaded> {
        self.directory.check()?;
        let named = self.directory.stamp("profiles.json")?;
        let Some(named) = named else {
            return self.load_missing();
        };
        need(named.private_file(), StoreFault::PrivateFile)?;
        let Some(mut file) = self.directory.read_file("profiles.json")? else {
            return Err(StoreError::Refused(StoreFault::FileRebound));
        };
        let result = self.read_current(&mut file, &named);
        let closed = private_fs::close(file, CloseRole::Data, self.directory.path());
        finalized(result, closed)
    }
    fn load_missing(&self) -> Result<Loaded> {
        self.directory.check()?;
        need(
            self.directory.stamp("profiles.json")?.is_none(),
            StoreFault::Changed,
        )?;
        Ok(Loaded {
            document: ProfileDocument::empty(),
            raw: Vec::new(),
            stamp: None,
        })
    }
    fn read_current(&self, file: &mut File, named: &Stamp) -> Result<Loaded> {
        let before = private_fs::private_stamp(file)?;
        need(&before == named, StoreFault::FileRebound)?;
        need(before.size <= MAX_BYTES as u64, StoreFault::StoreBound)?;
        let raw = private_fs::read_bounded(file, MAX_BYTES)?;
        #[cfg(test)]
        crate::faults::hit(crate::faults::Point::AfterDataRead, self.directory.path())?;
        need(
            raw.len() as u64 == before.size && private_fs::private_stamp(file)? == before,
            StoreFault::Changed,
        )?;
        need(
            self.directory.stamp("profiles.json")?.as_ref() == Some(&before),
            StoreFault::FileRebound,
        )?;
        let document = profiles_v1::decode(&raw).map_err(StoreError::Codec)?;
        self.directory.check()?;
        Ok(Loaded {
            document,
            raw,
            stamp: Some(before),
        })
    }
}
