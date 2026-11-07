use super::{ImageCache, Result, error::need};
use reverie_core::chat_images::MAX_FILE_BYTES;
use std::collections::BTreeSet;

impl ImageCache {
    pub(super) fn recover(&mut self) -> Result<()> {
        self.custody.current()?;
        let record = self.custody.read()?;
        let files = self
            .custody
            .cache()
            .image_names()?
            .into_iter()
            .collect::<BTreeSet<_>>();
        let Some((ledger, raw)) = record else {
            return need(files.is_empty(), "cache_not_empty");
        };
        if !ledger.cache_matches(self.custody.cache().identity()) {
            need(files.is_empty(), "cache_not_empty")?;
            if !ledger.entries().is_empty() {
                self.custody.retain(&raw)?;
            }
            return self.checkpoint();
        }
        let known = ledger
            .entries()
            .iter()
            .map(|entry| entry.name().as_str().as_bytes().to_vec())
            .collect::<BTreeSet<_>>();
        need(files.is_subset(&known), "cache_not_empty")?;
        let present = ledger
            .entries()
            .iter()
            .filter(|entry| files.contains(entry.name().as_str().as_bytes()))
            .collect::<Vec<_>>();
        // Every present file is read, hashed and checked-closed BEFORE deletion.
        for entry in &present {
            self.verify_record(entry)?;
        }
        self.custody.current()?;
        for entry in present {
            let stamp = self
                .custody
                .cache()
                .stamp(entry.name().as_str())?
                .ok_or(super::ImageStoreError::Refused("custody_changed"))?;
            need(
                stamp.private_file()
                    && stamp.size <= MAX_FILE_BYTES as u64
                    && entry.inode_matches([stamp.dev, stamp.ino]),
                "custody_changed",
            )?;
            self.custody
                .cache()
                .remove_temporary(entry.name().as_str(), &stamp)?;
        }
        self.custody.cache().sync()?;
        self.checkpoint()
    }
}
