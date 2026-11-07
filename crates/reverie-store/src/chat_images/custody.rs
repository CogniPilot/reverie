use super::{
    ImageStoreError, Result,
    error::{finalized, need},
};
use crate::private_fs::{self, CloseRole, Directory, Stamp};
use reverie_contracts::chat_images::{ImageLedger, LedgerEntry, decode_ledger, encode_ledger};
use reverie_core::decimal::UnsignedInteger;
use std::{fs::File, path::Path};
pub(super) const NAME: &str = ".chat-image-custody.json";
const RETAINED: &[u8] = b".chat-image-custody-retained-";
pub(super) struct Custody {
    state: Option<Directory>,
    cache: Option<Directory>,
    lock: Option<File>,
    close: CloseState,
}
#[derive(Clone, Copy)]
enum CloseState {
    Open,
    Closed,
    Unconfirmed,
}
impl Custody {
    pub(super) fn empty() -> Self {
        Self {
            state: None,
            cache: None,
            lock: None,
            close: CloseState::Open,
        }
    }
    pub(super) fn open(&mut self, state: &Path, cache: &Path) -> Result<()> {
        self.state = Some(Directory::open(state)?);
        self.lock = Some(self.state().lock_images().map_err(|error| {
            if matches!(
                error,
                crate::StoreError::Io {
                    fault: crate::StoreFault::LockBusy,
                    ..
                }
            ) {
                ImageStoreError::Refused("custody_busy")
            } else {
                error.into()
            }
        })?);
        self.cache = Some(Directory::open(cache)?);
        Ok(())
    }
    pub(super) fn state(&self) -> &Directory {
        self.state.as_ref().expect("owned image state")
    }
    pub(super) fn cache(&self) -> &Directory {
        self.cache.as_ref().expect("owned image cache")
    }
    pub(super) fn current(&self) -> Result<()> {
        need(self.require_active()?, "cache_unavailable")?;
        need(
            self.state.is_some() && self.cache.is_some() && self.lock.is_some(),
            "cache_unavailable",
        )?;
        self.state().check()?;
        self.cache().check()?;
        self.state().check_lock_named(
            self.lock.as_ref().expect("owned lock"),
            ".chat-image-custody.lock",
        )?;
        Ok(())
    }
    pub(super) fn require_active(&self) -> Result<bool> {
        match self.close {
            CloseState::Open => Ok(true),
            CloseState::Closed => Ok(false),
            CloseState::Unconfirmed => Err(ImageStoreError::Unconfirmed(Box::new(
                ImageStoreError::Refused("custody_unconfirmed"),
            ))),
        }
    }
    pub(super) fn read(&self) -> Result<Option<(ImageLedger, Vec<u8>)>> {
        let Some(mut file) = self.state().read_file(NAME)? else {
            return Ok(None);
        };
        let result = (|| {
            let stamp = private_fs::private_stamp(&file)?;
            need(stamp.size <= 65536, "custody_unavailable")?;
            let raw = private_fs::read_bounded(&mut file, 65536)?;
            Ok((decode_ledger(&raw)?, raw))
        })();
        finalized(
            result,
            private_fs::close(file, CloseRole::Data, self.state().path())
                .map_err(ImageStoreError::Close),
        )
        .map(Some)
    }
    pub(super) fn checkpoint(&self, entries: Vec<LedgerEntry>) -> Result<()> {
        self.current()?;
        let value = ImageLedger::try_new(
            self.cache().identity().map(UnsignedInteger::from_u64),
            entries,
        )?;
        let raw = encode_ledger(&value);
        need(raw.len() <= 65536, "custody_limit")?;
        let name = format!(".chat-image-custody-{}.tmp", private_fs::random_uuid()?);
        self.write_record(&name, &raw, true)
    }
    pub(super) fn retain(&self, raw: &[u8]) -> Result<()> {
        let retained = self
            .state()
            .image_names()?
            .iter()
            .filter(|name| name.starts_with(RETAINED))
            .count();
        need(retained < 16, "custody_retention_limit")?;
        let name = format!(
            ".chat-image-custody-retained-{}.json",
            private_fs::random_uuid()?
        );
        self.write_record(&name, raw, false)
    }
    fn write_record(&self, name: &str, raw: &[u8], replace: bool) -> Result<()> {
        let mut file = self.state().create_image_file(name)?;
        let mut stamp: Option<Stamp> = None;
        let result = (|| {
            stamp = Some(Stamp::from_metadata(
                &file.metadata().map_err(crate::StoreError::io)?,
            ));
            private_fs::write_all(&mut file, raw, self.state().path())?;
            if replace {
                self.state().publish_named(name, NAME, false)?;
            }
            self.state().sync()?;
            Ok(())
        })();
        let result = finalized(
            result,
            private_fs::close(file, CloseRole::Temporary, self.state().path())
                .map_err(ImageStoreError::Close),
        );
        if replace {
            finalized(
                result,
                stamp.map_or(Ok(()), |stamp| {
                    self.state()
                        .remove_temporary(name, &stamp)
                        .map_err(Into::into)
                }),
            )
        } else {
            result
        }
    }
    pub(super) fn close(&mut self) -> Result<()> {
        if !self.require_active()? {
            return Ok(());
        }
        self.close = CloseState::Unconfirmed;
        let result = self.lock.take().map_or(Ok(()), |file| {
            private_fs::close(file, CloseRole::Lock, self.state().path())
                .map_err(ImageStoreError::Close)
        });
        let result = finalized(
            result,
            self.cache.take().map_or(Ok(()), |cache| {
                cache.close().map_err(ImageStoreError::Close)
            }),
        );
        let result = finalized(
            result,
            self.state.take().map_or(Ok(()), |state| {
                state.close().map_err(ImageStoreError::Close)
            }),
        );
        if result.is_ok() {
            self.close = CloseState::Closed;
        }
        result
    }
}
impl Drop for Custody {
    fn drop(&mut self) {
        // An abandoned manager never releases the actual lock/FDs as an ACK.
        if let Some(file) = self.lock.take() {
            std::mem::forget(file);
        }
        if let Some(cache) = self.cache.take() {
            std::mem::forget(cache);
        }
        if let Some(state) = self.state.take() {
            std::mem::forget(state);
        }
    }
}
