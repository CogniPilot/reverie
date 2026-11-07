use super::{
    Entry, ImageCache, ImageCopy, Result,
    error::{finalized, need},
};
use crate::private_fs::{self, CloseRole, Stamp};
use reverie_contracts::chat_images::{LedgerEntry, image_digest, image_format};
use reverie_core::{
    chat_images::{ImageFileName, MAX_CACHE_BYTES, MAX_CACHE_FILES},
    decimal::UnsignedInteger,
};
use std::time::Instant;

impl ImageCache {
    /// The actor has freshly authorized these bytes; this owner never fetches
    /// URLs or derives authority from the chosen filename or image signature.
    pub fn install(&mut self, bytes: &[u8], now: Instant) -> Result<ImageCopy> {
        self.current()?;
        let format = image_format(bytes)?;
        let total = self
            .entries
            .values()
            .map(|entry| entry.record.size())
            .sum::<usize>();
        need(
            self.entries.len() < MAX_CACHE_FILES && total + bytes.len() <= MAX_CACHE_BYTES,
            "cache_limit",
        )?;
        let name = ImageFileName::parse(&format!(
            "{}.{}",
            private_fs::random_uuid()?,
            format.extension()
        ))
        .expect("closed random UUID and raster suffix");
        let mut file = self.custody.cache().create_image_file(name.as_str())?;
        let mut adopted = false;
        let result = (|| {
            let stamp = Stamp::from_metadata(&file.metadata().map_err(crate::StoreError::io)?);
            let record = LedgerEntry::try_new(
                name.clone(),
                [stamp.dev, stamp.ino].map(UnsignedInteger::from_u64),
                bytes.len(),
                image_digest(bytes),
            )?;
            self.entries.insert(
                name.clone(),
                Entry {
                    record,
                    stamp,
                    expires: Self::deadline(now),
                },
            );
            adopted = true;
            private_fs::write_all(&mut file, bytes, self.custody.cache().path())?;
            let finished = private_fs::private_stamp(&file)?;
            need(finished.size == bytes.len() as u64, "write_unconfirmed")
        })();
        let result = finalized(
            result,
            private_fs::close(file, CloseRole::Data, self.custody.cache().path())
                .map_err(Into::into),
        );
        let result = result.and_then(|()| {
            self.verify(self.entries.get(&name).expect("adopted new image"))?;
            self.checkpoint()?;
            Ok(ImageCopy {
                origin: self.origin.clone(),
                name: name.clone(),
                bytes: bytes.len(),
            })
        });
        match result {
            Ok(copy) => Ok(copy),
            Err(error) if adopted => {
                let result = finalized(Err(error), self.remove(&name));
                self.failed = true;
                result
            }
            Err(error) => {
                // No fstat means the real exclusive file's identity is unknown;
                // preserve its name and fence this manager, never guess-delete.
                self.failed = true;
                Err(error)
            }
        }
    }
}
