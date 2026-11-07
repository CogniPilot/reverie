use super::*;
fn expiry(shared: Arc<Shared>) {
    loop {
        let guard = shared
            .waiting
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if shared.stopped.load(Ordering::Acquire) {
            return;
        }
        let waited = shared.wake.wait_timeout(guard, Duration::from_millis(500));
        if waited.is_err() {
            shared.failed.store(true, Ordering::Release);
            return;
        }
        if shared.stopped.load(Ordering::Acquire) {
            return;
        }
        let result = shared
            .cache
            .lock()
            .map_err(|_| ())
            .and_then(|mut cache| cache.expire(Instant::now()).map_err(|_| ()));
        if result.is_err() {
            shared.failed.store(true, Ordering::Release);
            return;
        }
    }
}
impl ChatImageCache {
    pub(super) fn start(&self) -> CacheResult<()> {
        let mut slot = self
            .thread
            .lock()
            .map_err(|_| ImageCacheError::Refused("cache_unavailable"))?;
        let shared = self.shared.clone();
        *slot = Some(
            std::thread::Builder::new()
                .name("chat-image-expiry".into())
                .spawn(move || expiry(shared))
                .map_err(ImageCacheError::Thread)?,
        );
        Ok(())
    }
    fn end(&self, end: Instant) -> Instant {
        self.budget.deadline().map_or(end, |stop| end.min(stop))
    }
    fn joined(&self, end: Instant) -> CacheResult<()> {
        require(
            !self.join_failed.load(Ordering::Acquire),
            "expiry_unsettled",
        )?;
        self.shared.stopped.store(true, Ordering::Release);
        self.shared.wake.notify_all();
        loop {
            let mut slot = self
                .thread
                .try_lock()
                .map_err(|_| ImageCacheError::Refused("expiry_unsettled"))?;
            if slot.as_ref().is_none_or(JoinHandle::is_finished) {
                return self.join_finished(slot.take());
            }
            drop(slot);
            require(Instant::now() < self.end(end), "expiry_unsettled")?;
            std::thread::sleep(Duration::from_millis(5));
        }
    }
    fn join_finished(&self, thread: Option<JoinHandle<()>>) -> CacheResult<()> {
        if let Some(thread) = thread
            && thread.join().is_err()
        {
            self.join_failed.store(true, Ordering::Release);
            return Err(ImageCacheError::Refused("expiry_unsettled"));
        }
        Ok(())
    }
    fn with_closed_reaper(&self, end: Instant, retire: bool) -> CacheResult<()> {
        if self.closed.load(Ordering::Acquire) {
            return Ok(());
        }
        require(
            self.claimed
                .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                .is_ok(),
            "busy",
        )?;
        let result = (|| {
            self.joined(end)?;
            self.close_store(end, retire)
        })();
        self.claimed.store(false, Ordering::Release);
        if result.is_ok() {
            self.closed.store(true, Ordering::Release);
        }
        result.map_err(|error| ImageCacheError::Retained(Box::new(error)))
    }
    fn close_store(&self, end: Instant, retire: bool) -> CacheResult<()> {
        loop {
            if let Ok(mut cache) = self.shared.cache.try_lock() {
                return self.finish_cache(&mut cache, end, retire);
            }
            require(Instant::now() < self.end(end), "cleanup_unsettled")?;
            std::thread::sleep(Duration::from_millis(5));
        }
    }
    fn finish_cache(&self, cache: &mut ImageCache, end: Instant, retire: bool) -> CacheResult<()> {
        let result = if retire {
            cache.retire()
        } else {
            cache.close(self.end(end))
        };
        result.map_err(ImageCacheError::Store)
    }
    pub fn retire(&self) -> CacheResult<()> {
        self.with_closed_reaper(Instant::now() + Duration::from_secs(2), true)
    }
    pub fn close(&self, end: Instant) -> CacheResult<()> {
        self.with_closed_reaper(end, false)
    }
}
impl Drop for ChatImageCache {
    fn drop(&mut self) {
        if self.closed.load(Ordering::Acquire) {
            return;
        }
        // Default Drop cannot claim actual reaper/FD settlement or replay close.
        if let Some(thread) = self
            .thread
            .get_mut()
            .unwrap_or_else(|error| error.into_inner())
            .take()
        {
            std::mem::forget(thread);
        }
        std::mem::forget(self.shared.clone());
    }
}
