//! Regenerable image bytes and their existing host-private custody ledger.
//! Paths here are storage DATA. The Host/App actor supplies actual Office,
//! current employee, namespace and report-record ownership before using it.
mod custody;
mod error;
mod files;
mod recovery;
#[cfg(test)]
mod tests;
mod write;
use crate::private_fs::Stamp;
pub use error::{ImageStoreError, Result};
use reverie_contracts::chat_images::LedgerEntry;
use reverie_core::chat_images::{ImageFileName, LIFETIME_SECONDS};
use std::{
    path::Path,
    sync::Arc,
    time::{Duration, Instant},
};

struct Entry {
    record: LedgerEntry,
    stamp: Stamp,
    expires: Instant,
}
/// An installed copy tied to this actual cache instance, not a path capability.
pub struct ImageCopy {
    origin: Arc<()>,
    name: ImageFileName,
    bytes: usize,
}
impl ImageCopy {
    pub fn name(&self) -> &ImageFileName {
        &self.name
    }
    pub fn bytes(&self) -> usize {
        self.bytes
    }
}
pub struct ImageCache {
    custody: custody::Custody,
    entries: Vec<Entry>,
    origin: Arc<()>,
    failed: bool,
}
/// Construction failure retains the actual owner if its finalization refused.
pub struct ImageCacheOpenFailure {
    pub error: ImageStoreError,
    pub retained: Option<Box<ImageCache>>,
}
impl ImageCache {
    pub fn prepare_root(temporary: &Path) -> Result<std::path::PathBuf> {
        let parent = crate::private_fs::Directory::open(temporary)?;
        let result = parent.prepare_image_child().map_err(Into::into);
        error::finalized(result, parent.close().map_err(Into::into))
    }
    pub fn open(state: &Path, root: &Path) -> std::result::Result<Self, ImageCacheOpenFailure> {
        let mut cache = Self {
            custody: custody::Custody::empty(),
            entries: Vec::new(),
            origin: Arc::new(()),
            failed: false,
        };
        let opened = cache
            .custody
            .open(state, root)
            .and_then(|()| cache.recover());
        match opened {
            Ok(()) => Ok(cache),
            Err(error) => match cache.custody.close() {
                Ok(()) => Err(ImageCacheOpenFailure {
                    error,
                    retained: None,
                }),
                Err(close) => {
                    cache.failed = true;
                    Err(ImageCacheOpenFailure {
                        error: error::finalized::<()>(Err(error), Err(close))
                            .expect_err("two errors"),
                        retained: Some(Box::new(cache)),
                    })
                }
            },
        }
    }
    fn current(&self) -> Result<()> {
        error::need(!self.failed, "cache_unavailable")?;
        self.custody.current()
    }
    pub fn begin(&mut self, now: Instant) -> Result<()> {
        self.current()?;
        self.expire(now)
    }
    pub fn verify_copies(&self, copies: &[ImageCopy], now: Instant) -> Result<Vec<u64>> {
        self.current()?;
        copies
            .iter()
            .map(|copy| {
                error::need(Arc::ptr_eq(&self.origin, &copy.origin), "write_unconfirmed")?;
                let entry = self
                    .entries
                    .iter()
                    .find(|entry| entry.record.name() == &copy.name)
                    .ok_or(ImageStoreError::Refused("write_unconfirmed"))?;
                self.verify(entry)?;
                error::need(entry.expires > now, "expired")?;
                Ok(entry.expires.duration_since(now).as_secs().max(1))
            })
            .collect()
    }
    pub fn rollback(&mut self, copies: &[ImageCopy]) -> Result<()> {
        error::need(self.custody.require_active()?, "cache_unavailable")?;
        let mut result = Ok(());
        for copy in copies {
            let removed = error::need(Arc::ptr_eq(&self.origin, &copy.origin), "cache_changed")
                .and_then(|()| self.remove(&copy.name));
            result = error::finalized(result, removed);
        }
        result
    }
    pub fn expire(&mut self, now: Instant) -> Result<()> {
        self.current()?;
        let names = self
            .entries
            .iter()
            .filter(|entry| entry.expires <= now)
            .map(|entry| entry.record.name().clone())
            .collect::<Vec<_>>();
        for name in names {
            self.remove(&name)?;
        }
        Ok(())
    }
    /// Close after the Host's actual reaper has joined, preserving one deadline.
    pub fn close(&mut self, end: Instant) -> Result<()> {
        if !self.custody.require_active()? {
            return Ok(());
        }
        let names = self
            .entries
            .iter()
            .map(|entry| entry.record.name().clone())
            .collect::<Vec<_>>();
        for name in names {
            error::need(Instant::now() < end, "busy")?;
            self.remove(&name)?;
        }
        error::need(Instant::now() < end, "busy")?;
        self.custody.close()
    }
    /// Retiring a changed generation preserves bytes and ledger for recovery.
    pub fn retire(&mut self) -> Result<()> {
        self.custody.close()
    }
    fn deadline(now: Instant) -> Instant {
        now + Duration::from_secs(LIFETIME_SECONDS)
    }
}
