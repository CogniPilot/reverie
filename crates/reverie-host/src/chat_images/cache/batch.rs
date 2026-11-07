use super::*;
use reverie_contracts::chat_images::{ReadyImage, ready_response};
impl ImageMaterialization {
    pub fn fetch_next(
        &mut self,
        runtime: &WorkerRuntime,
        binding: &ObservedImageBinding,
    ) -> CacheResult<()> {
        self.cache.current(runtime, binding)?;
        require(
            !self.released
                && !self.complete
                && self.download.is_none()
                && self.made.len() < self.scope.files().len(),
            "invalid_files",
        )?;
        let file = &self.scope.files()[self.made.len()];
        match self.cache.reader.fetch(runtime, &self.scope, file) {
            Ok(bytes) => {
                self.download = Some(bytes);
                Ok(())
            }
            Err(error) => {
                self.uncertain |= error.is_uncertain();
                Err(ImageCacheError::Office(error))
            }
        }
    }
    pub fn install_download(
        &mut self,
        runtime: &WorkerRuntime,
        binding: &ObservedImageBinding,
    ) -> CacheResult<()> {
        require(!self.released && !self.complete, "cache_unavailable")?;
        self.cache.current(runtime, binding)?;
        let bytes = self
            .download
            .take()
            .ok_or(ImageCacheError::Refused("invalid_files"))?;
        self.total += bytes.len();
        require(
            self.total <= reverie_core::chat_images::MAX_REQUEST_BYTES,
            "request_limit",
        )?;
        let mut cache = self
            .cache
            .shared
            .cache
            .lock()
            .map_err(|_| ImageCacheError::Refused("cache_unavailable"))?;
        match cache.install(&bytes, Instant::now()) {
            Ok(copy) => {
                self.made.push(copy);
                Ok(())
            }
            Err(error) => {
                self.uncertain = true;
                Err(ImageCacheError::Store(error))
            }
        }
    }
    pub fn ready(
        &mut self,
        runtime: &WorkerRuntime,
        binding: &ObservedImageBinding,
    ) -> CacheResult<Vec<u8>> {
        self.cache.current(runtime, binding)?;
        require(
            !self.released
                && !self.complete
                && self.made.len() == self.scope.files().len()
                && self.download.is_none()
                && !self.uncertain,
            "write_unconfirmed",
        )?;
        let cache = self
            .cache
            .shared
            .cache
            .lock()
            .map_err(|_| ImageCacheError::Refused("cache_unavailable"))?;
        let lifetimes = cache
            .verify_copies(&self.made, Instant::now())
            .map_err(ImageCacheError::Store)?;
        let files = self
            .made
            .iter()
            .zip(self.scope.files())
            .zip(lifetimes)
            .map(|((copy, file), ttl)| {
                ReadyImage::try_new(file.clone(), copy.name().clone(), copy.bytes(), ttl)
            })
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(|_| ImageCacheError::Refused("write_unconfirmed"))?;
        let response = ready_response(&self.scope, &files)
            .map_err(|_| ImageCacheError::Refused("write_unconfirmed"))?;
        self.complete = true;
        Ok(response)
    }
    pub fn conclude(&mut self) -> CacheResult<()> {
        require(
            self.complete && !self.uncertain && !self.released,
            "write_unconfirmed",
        )?;
        self.released = true;
        self.cache.claimed.store(false, Ordering::Release);
        Ok(())
    }
    pub fn abort(&mut self) -> CacheResult<()> {
        require(!self.released, "cache_unavailable")?;
        let result = self
            .cache
            .shared
            .cache
            .lock()
            .map_err(|_| ImageCacheError::Refused("cache_unavailable"))?
            .rollback(&self.made)
            .map_err(ImageCacheError::Store);
        if result.is_err() {
            self.uncertain = true;
        }
        result?;
        require(!self.uncertain, "custody_unconfirmed")?;
        self.download = None;
        self.released = true;
        self.cache.claimed.store(false, Ordering::Release);
        Ok(())
    }
}
