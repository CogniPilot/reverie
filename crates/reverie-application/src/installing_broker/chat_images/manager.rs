use super::*;
use std::sync::{MutexGuard, TryLockError};
// Counts 0..=2 and the terminal bit share ONE linearization point. A close
// cannot observe zero and succeed while a subsequent admission enters.
const CLOSED: usize = 4;
impl ChatImages {
    pub(in crate::installing_broker) fn new() -> Self {
        Self {
            entries: Mutex::new(Vec::new()),
            admitted: AtomicUsize::new(0),
        }
    }
    pub(super) fn admit(self: &Arc<Self>) -> Result<GlobalPermit> {
        self.admitted
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |active| {
                (active < 2).then_some(active + 1)
            })
            .map_err(|state| {
                ChatImagesError::Refused(if state & CLOSED == 0 {
                    "busy"
                } else {
                    "cache_unavailable"
                })
            })?;
        Ok(GlobalPermit {
            owner: self.clone(),
            released: false,
        })
    }
    pub(in crate::installing_broker) fn known_empty_for_drop(&self) -> bool {
        self.admitted.load(Ordering::Acquire) & !CLOSED == 0
            && self
                .entries
                .try_lock()
                .is_ok_and(|entries| entries.is_empty())
    }
    fn lock_until(&self, end: Instant) -> Result<MutexGuard<'_, Vec<Arc<ChatImageCache>>>> {
        loop {
            match self.entries.try_lock() {
                Ok(entries) => return Ok(entries),
                Err(TryLockError::Poisoned(_)) => {
                    return Err(ChatImagesError::Refused("cache_unavailable"));
                }
                Err(TryLockError::WouldBlock) => {}
            }
            need(Instant::now() < end, "cleanup_unsettled")?;
            std::thread::sleep(Duration::from_millis(5));
        }
    }
    pub(super) fn close(&self, end: Instant) -> Result<()> {
        self.admitted.fetch_or(CLOSED, Ordering::AcqRel);
        let mut entries = self.lock_until(end)?;
        let mut failed = Vec::new();
        entries.retain(|cache| match cache.close(end) {
            Ok(()) => false,
            Err(error) => {
                failed.push(ChatImagesError::Cache(error));
                true
            }
        });
        if !failed.is_empty() {
            return Err(ChatImagesError::Cleanup(failed));
        }
        need(self.admitted.load(Ordering::Acquire) & !CLOSED == 0, "busy")
    }
}
impl InstallingBroker {
    /// Component shutdown only; every cache owner remains registered on error.
    pub fn close_chat_images(&self, end: Instant) -> Result<()> {
        let end = self
            .storage
            .runtime
            .stop_deadline()
            .map_or(end, |stop| end.min(stop));
        self.images.close(end)
    }
    pub(super) fn select_image_cache(
        &self,
        scope: &reverie_core::chat_images::ImageScope,
        observed: ObservedImageBinding,
        owner: &mut HandlerOwner,
    ) -> Result<Arc<ChatImageCache>> {
        let mut entries = self
            .images
            .entries
            .lock()
            .map_err(|_| ChatImagesError::Refused("cache_unavailable"))?;
        need(
            self.images.admitted.load(Ordering::Acquire) & CLOSED == 0,
            "cache_unavailable",
        )?;
        let mut index = 0;
        while index < entries.len() {
            let cache = &entries[index];
            let changed =
                cache.session() == scope.session() && cache.generation() != scope.generation();
            let alias = cache.session() != scope.session()
                && cache.storage_root() == observed.storage_root();
            if changed || alias {
                cache.retire().map_err(ChatImagesError::Cache)?;
                entries.remove(index);
            } else {
                index += 1;
            }
        }
        if let Some(cache) = entries
            .iter()
            .find(|cache| cache.session() == scope.session())
        {
            return Ok(cache.clone());
        }
        entries
            .try_reserve(1)
            .map_err(|_| ChatImagesError::Refused("cache_unavailable"))?;
        observed
            .prepare_cache_root()
            .map_err(ChatImagesError::Storage)?;
        let current = self.observe_image(scope.session(), true)?;
        need(
            current.binding.generation() == scope.generation(),
            "binding_changed",
        )?;
        let reader = current
            .phone
            .into_reader(&self.storage.runtime)
            .map_err(|error| ChatImagesError::Cache(ImageCacheError::Office(error)))?;
        match ChatImageCache::capture(&self.storage.runtime, current.binding, reader) {
            Ok(cache) => {
                entries.push(cache.clone());
                Ok(cache)
            }
            Err(failure) => {
                let code = failure.error.code();
                owner.capture = Some(failure);
                Err(ChatImagesError::Refused(code))
            }
        }
    }
}
