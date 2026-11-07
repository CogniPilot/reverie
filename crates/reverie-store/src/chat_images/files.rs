use super::{
    Entry, ImageCache, Result,
    error::{finalized, need},
};
use crate::private_fs::{self, CloseRole, Stamp};
use reverie_contracts::chat_images::{LedgerEntry, image_digest};
use reverie_core::chat_images::{ImageFileName, MAX_FILE_BYTES};

impl ImageCache {
    pub(super) fn checkpoint(&mut self) -> Result<()> {
        let result = self.custody.checkpoint(
            self.entries
                .values()
                .map(|entry| entry.record.clone())
                .collect(),
        );
        if result.is_err() {
            self.failed = true;
        }
        result
    }
    pub(super) fn verify(&self, entry: &Entry) -> Result<()> {
        self.verify_record(&entry.record)
    }
    pub(super) fn verify_record(&self, entry: &LedgerEntry) -> Result<()> {
        let mut file = self
            .custody
            .cache()
            .read_file(entry.name().as_str())?
            .ok_or(super::ImageStoreError::Refused("write_unconfirmed"))?;
        let result = (|| {
            let before = Stamp::from_metadata(&file.metadata().map_err(crate::StoreError::io)?);
            need(
                before.private_file()
                    && before.size == entry.size() as u64
                    && before.size <= MAX_FILE_BYTES as u64
                    && entry.inode_matches([before.dev, before.ino]),
                "write_unconfirmed",
            )?;
            let bytes = private_fs::read_bounded(&mut file, entry.size())?;
            let after = Stamp::from_metadata(&file.metadata().map_err(crate::StoreError::io)?);
            need(
                before.same_generation(&after) && image_digest(&bytes) == *entry.digest(),
                "write_unconfirmed",
            )
        })();
        finalized(
            result,
            private_fs::close(file, CloseRole::Data, self.custody.cache().path())
                .map_err(Into::into),
        )
    }
    pub(super) fn remove(&mut self, name: &ImageFileName) -> Result<()> {
        let Some(entry) = self.entries.get(name) else {
            return Ok(());
        };
        let stamp = entry.stamp.clone();
        let result = (|| {
            if let Some(current) = self.custody.cache().stamp(name.as_str())? {
                need(
                    current.same_inode(&stamp) && current.owned_regular(),
                    "cache_changed",
                )?;
                self.custody
                    .cache()
                    .remove_temporary(name.as_str(), &stamp)?;
            }
            self.entries.remove(name);
            self.checkpoint()
        })();
        if result.is_err() {
            self.failed = true;
        }
        result
    }
}
