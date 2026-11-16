use crate::{
    Error, Result,
    document::{self, Command, Document},
    filesystem::Directory,
};
use serde_json::{Value, json};
use std::{
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
};

/// This service must be explicitly selected for a newly created empty instance.
/// No existing company or authentication file is imported, overwritten or reset.
pub fn initialize(path: impl AsRef<Path>) -> Result<()> {
    initialize_checked(path.as_ref(), |_| Ok(()))
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum BootstrapStage {
    Staged,
    Credential,
    Company,
    BeforePublish,
    Published,
}
fn initialize_checked(
    path: &Path,
    checkpoint: impl Fn(BootstrapStage) -> Result<()>,
) -> Result<()> {
    let directory = Directory::stage(path)?;
    checkpoint(BootstrapStage::Staged)?;
    let secret = document::secret()?;
    let document = Document::fresh(&secret)?;
    directory.create_file(
        "owner-credential.json",
        &serde_json::to_vec(&json!({"version":1,"token":secret})).map_err(|_| Error::Storage)?,
    )?;
    checkpoint(BootstrapStage::Credential)?;
    directory.create_file("company.json", &document.encode()?)?;
    checkpoint(BootstrapStage::Company)?;
    checkpoint(BootstrapStage::BeforePublish)?;
    directory.publish_fresh(path)?;
    checkpoint(BootstrapStage::Published).map_err(|_| Error::PublicationUnconfirmed)
}
pub fn initialization_status(path: impl AsRef<Path>) -> Result<Value> {
    let path = path.as_ref();
    let directory = Directory::open(path)?;
    let document = Document::decode(&directory.read("company.json")?)?;
    let token = crate::client::credential(&path.join("owner-credential.json"))?;
    document.initialization_status(&token)
}

#[cfg(test)]
pub(crate) mod tests;

pub struct CompanyStore {
    directory: Directory,
    write_uncertain: AtomicBool,
    accepting: AtomicBool,
    active: AtomicUsize,
}
pub(crate) struct RequestLease(Arc<CompanyStore>);
impl RequestLease {
    pub(crate) fn store(&self) -> &CompanyStore {
        &self.0
    }
}
impl Drop for RequestLease {
    fn drop(&mut self) {
        self.0.active.fetch_sub(1, Ordering::SeqCst);
    }
}
impl CompanyStore {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let directory = Directory::open(path.as_ref())?;
        Document::decode(&directory.read("company.json")?)?;
        Ok(Self {
            directory,
            write_uncertain: AtomicBool::new(false),
            accepting: AtomicBool::new(true),
            active: AtomicUsize::new(0),
        })
    }
    fn transaction(
        &self,
        call: impl FnOnce(&mut Document) -> Result<(Value, bool)>,
    ) -> Result<Value> {
        let lock = self.directory.lock()?;
        let mut published = false;
        let result = (|| {
            self.directory.require_lock(&lock)?;
            let before = self.directory.read("company.json")?;
            let mut document = Document::decode(&before)?;
            let (result, changed) = call(&mut document)?;
            if changed {
                let bytes = document.encode()?;
                self.directory
                    .publish(&bytes, || self.publication_current(&lock, &before))?;
                published = true;
            }
            self.directory.require_lock(&lock)?;
            self.directory.current()?;
            Ok(result)
        })();
        let finished = self.directory.unlock(lock);
        let result = match (result, finished) {
            (Ok(value), Ok(())) => Ok(value),
            (Err(_), _) if published => Err(Error::PublicationUnconfirmed),
            (Err(error), _) => Err(error),
            (Ok(_), Err(_)) if published => Err(Error::PublicationUnconfirmed),
            (Ok(_), Err(error)) => Err(error),
        };
        if matches!(result, Err(Error::PublicationUnconfirmed)) {
            self.write_uncertain.store(true, Ordering::SeqCst);
        }
        result
    }
    fn publication_current(&self, lock: &std::fs::File, before: &[u8]) -> Result<()> {
        if !self.accepting.load(Ordering::SeqCst) {
            return Err(Error::Busy);
        }
        self.directory.require_lock(lock)?;
        if self.directory.read("company.json")? != before {
            return Err(Error::Conflict);
        }
        Ok(())
    }
    pub(crate) fn employees(&self, token: &str) -> Result<Value> {
        self.transaction(|d| d.employees(token).map(|value| (value, false)))
    }
    pub(crate) fn operation(&self, token: &str, request: &str) -> Result<Value> {
        self.transaction(|d| d.operation(token, request).map(|value| (value, false)))
    }
    pub(crate) fn apply(&self, token: &str, command: Command) -> Result<Value> {
        self.transaction(|d| {
            if self.write_uncertain.load(Ordering::SeqCst) {
                return Err(Error::PublicationUnconfirmed);
            }
            d.apply(token, command)
        })
    }
    pub(crate) fn begin_request(self: &Arc<Self>) -> Result<RequestLease> {
        if !self.accepting.load(Ordering::SeqCst) {
            return Err(Error::Busy);
        }
        self.active.fetch_add(1, Ordering::SeqCst);
        let lease = RequestLease(Arc::clone(self));
        if !self.accepting.load(Ordering::SeqCst) {
            return Err(Error::Busy);
        }
        Ok(lease)
    }
    pub(crate) fn shutdown(&self) {
        self.accepting.store(false, Ordering::SeqCst);
    }
    pub(crate) fn active_requests(&self) -> usize {
        self.active.load(Ordering::SeqCst)
    }
}
