//! Actual per-binding cache/thread lifetime. App retains this manager owner
//! before it can release the authenticated report's lifecycle hold.
mod batch;
mod lifetime;
use super::*;
use crate::{
    office::{OfficeImageError, OfficeImageReader},
    worker_runtime::WorkerStopBudget,
};
use reverie_core::{chat_images::ImageScope, ids::ProfileSessionId};
use reverie_store::chat_images::{ImageCache, ImageCopy, ImageStoreError};
use std::{
    sync::{
        Condvar, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread::JoinHandle,
    time::Duration,
};

#[derive(Debug)]
pub enum ImageCacheError {
    Refused(&'static str),
    Store(ImageStoreError),
    Office(OfficeImageError),
    Thread(std::io::Error),
    Finalization {
        primary: Box<Self>,
        secondary: Box<Self>,
    },
}
impl ImageCacheError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Refused(code) => code,
            Self::Store(error) => error.code(),
            Self::Office(error) => error.code(),
            Self::Thread(_) | Self::Finalization { .. } => "cache_unavailable",
        }
    }
}
impl fmt::Display for ImageCacheError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.write_str(self.code())
    }
}
impl std::error::Error for ImageCacheError {}
type CacheResult<T> = std::result::Result<T, ImageCacheError>;
fn require(value: bool, code: &'static str) -> CacheResult<()> {
    if value {
        Ok(())
    } else {
        Err(ImageCacheError::Refused(code))
    }
}
struct Shared {
    cache: Mutex<ImageCache>,
    stopped: AtomicBool,
    failed: AtomicBool,
    wake: Condvar,
    waiting: Mutex<()>,
}
pub struct ChatImageCache {
    shared: Arc<Shared>,
    thread: Mutex<Option<JoinHandle<()>>>,
    claimed: AtomicBool,
    closed: AtomicBool,
    join_failed: AtomicBool,
    budget: WorkerStopBudget,
    binding: ObservedImageBinding,
    reader: OfficeImageReader,
}
pub struct ImageCacheCaptureFailure {
    pub error: ImageCacheError,
    pub retained: Option<Arc<ChatImageCache>>,
    pub store: Option<Box<ImageCache>>,
}
pub struct ImageMaterialization {
    cache: Arc<ChatImageCache>,
    scope: ImageScope,
    made: Vec<ImageCopy>,
    download: Option<Vec<u8>>,
    total: usize,
    uncertain: bool,
    released: bool,
    complete: bool,
}
impl ChatImageCache {
    pub fn capture(
        runtime: &WorkerRuntime,
        binding: ObservedImageBinding,
        reader: OfficeImageReader,
    ) -> std::result::Result<Arc<Self>, Box<ImageCacheCaptureFailure>> {
        let checked = require(
            matches!(binding.phase, BindingPhase::Cache)
                && binding.selection.assert_runtime(runtime).is_ok()
                && binding.selection.paths().session() == reader.session(),
            "binding_changed",
        )
        .and_then(|()| {
            reader
                .identity(runtime)
                .map(|_| ())
                .map_err(ImageCacheError::Office)
        });
        if let Err(error) = checked {
            return Err(Box::new(ImageCacheCaptureFailure {
                error,
                retained: None,
                store: None,
            }));
        }
        let root = binding
            .temporary
            .join(reverie_core::chat_images::CACHE_NAME);
        let cache =
            ImageCache::open(binding.selection.paths().root(), &root).map_err(|failure| {
                Box::new(ImageCacheCaptureFailure {
                    error: ImageCacheError::Store(failure.error),
                    retained: None,
                    store: failure.retained,
                })
            })?;
        let owner = Arc::new(Self {
            shared: Arc::new(Shared {
                cache: Mutex::new(cache),
                stopped: AtomicBool::new(false),
                failed: AtomicBool::new(false),
                wake: Condvar::new(),
                waiting: Mutex::new(()),
            }),
            thread: Mutex::new(None),
            claimed: AtomicBool::new(false),
            closed: AtomicBool::new(false),
            join_failed: AtomicBool::new(false),
            budget: runtime.stop_budget(),
            binding,
            reader,
        });
        let result = owner.start();
        match result {
            Ok(()) => Ok(owner),
            Err(error) => {
                let close = owner.retire();
                let (error, retained) = match close {
                    Ok(()) => (error, None),
                    Err(close) => (
                        ImageCacheError::Finalization {
                            primary: Box::new(error),
                            secondary: Box::new(close),
                        },
                        Some(owner),
                    ),
                };
                Err(Box::new(ImageCacheCaptureFailure {
                    error,
                    retained,
                    store: None,
                }))
            }
        }
    }
    pub fn storage_root(&self) -> &Path {
        self.binding.storage_root()
    }
    pub fn session(&self) -> &ProfileSessionId {
        self.binding.selection.paths().session()
    }
    pub fn generation(&self) -> &ImageDigest {
        self.binding.generation()
    }
    fn current(&self, runtime: &WorkerRuntime, binding: &ObservedImageBinding) -> CacheResult<()> {
        require(
            self.budget.same_runtime(runtime)
                && matches!(binding.phase, BindingPhase::Cache)
                && binding.selection.assert_runtime(runtime).is_ok()
                && self.session() == binding.selection.paths().session()
                && self.generation() == binding.generation()
                && self.storage_root() == binding.storage_root(),
            "binding_changed",
        )?;
        require(
            !self.shared.stopped.load(Ordering::Acquire)
                && !self.shared.failed.load(Ordering::Acquire),
            "cache_unavailable",
        )?;
        let thread = self
            .thread
            .try_lock()
            .map_err(|_| ImageCacheError::Refused("cache_unavailable"))?;
        require(
            thread.as_ref().is_some_and(|thread| !thread.is_finished()),
            "cache_unavailable",
        )
    }
    pub fn begin(
        self: &Arc<Self>,
        runtime: &WorkerRuntime,
        scope: ImageScope,
        binding: &ObservedImageBinding,
    ) -> CacheResult<ImageMaterialization> {
        require(
            self.claimed
                .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                .is_ok(),
            "busy",
        )?;
        let result = self.current(runtime, binding).and_then(|()| {
            require(
                scope.session() == self.session() && scope.generation() == self.generation(),
                "binding_changed",
            )?;
            self.shared
                .cache
                .lock()
                .map_err(|_| ImageCacheError::Refused("cache_unavailable"))?
                .begin(Instant::now())
                .map_err(ImageCacheError::Store)
        });
        match result {
            Ok(()) => Ok(ImageMaterialization {
                cache: self.clone(),
                scope,
                made: Vec::new(),
                download: None,
                total: 0,
                uncertain: false,
                released: false,
                complete: false,
            }),
            Err(error) => {
                self.claimed.store(false, Ordering::Release);
                Err(error)
            }
        }
    }
}
