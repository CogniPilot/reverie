//! Fixed native observations for the installing M actor. Neither a request SID
//! nor these observed projection values grants website/file/lifecycle access.
mod cache;
mod isolation;
mod namespace;
mod observe;
use crate::{
    captured_client::CapturedCall, installed_worker_engine::InstalledWorkerEngine,
    worker_runtime::WorkerRuntime, worker_storage::StorageSelection,
};
pub use cache::{ChatImageCache, ImageCacheCaptureFailure, ImageCacheError, ImageMaterialization};
use reverie_core::chat_images::ImageDigest;
use std::{
    fmt,
    path::{Path, PathBuf},
    sync::Arc,
    time::Instant,
};
#[derive(Debug)]
pub enum ImageObserveError {
    Refused(&'static str),
    Data(reverie_contracts::chat_images::ImageDataError),
    Storage(Box<crate::worker_storage::StorageOwnerError>),
    Engine(Box<crate::worker_source_stop::SourceStopError>),
    Office(crate::office::OfficeImageError),
    Io(std::io::Error),
    Kernel(crate::reservation_kernel::ReservationKernelError),
}
impl ImageObserveError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Refused(code) => code,
            Self::Data(error) => error.code(),
            Self::Office(error) => error.code(),
            _ => "materialization_unavailable",
        }
    }
}
impl fmt::Display for ImageObserveError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.write_str(self.code())
    }
}
impl std::error::Error for ImageObserveError {}
type Result<T> = std::result::Result<T, ImageObserveError>;
fn need(value: bool, code: &'static str) -> Result<()> {
    if value {
        Ok(())
    } else {
        Err(ImageObserveError::Refused(code))
    }
}
struct QueryOwner {
    origin: Arc<InstalledWorkerEngine>,
    pending: Option<CapturedCall>,
}
/// A failed read still owns its exact captured native call. Settlement never
/// upgrades its original failure into binding success or replays the query.
pub struct ImageObservationFailure {
    query: QueryOwner,
    cause: ImageObserveError,
}
impl ImageObservationFailure {
    pub fn error(&self) -> &ImageObserveError {
        &self.cause
    }
    pub fn has_pending_native(&self) -> bool {
        self.query.pending.is_some()
    }
    pub fn settle(&mut self, end: Instant) -> Result<()> {
        if let Some(call) = &self.query.pending {
            self.query
                .origin
                .engine
                .client
                .settle_call(call, end)
                .map_err(|error| {
                    ImageObserveError::Engine(Box::new(
                        crate::worker_source_stop::SourceStopError::Engine(error.into()),
                    ))
                })?;
            self.query.pending = None;
        }
        Ok(())
    }
}
impl Drop for ImageObservationFailure {
    fn drop(&mut self) {
        if let Some(call) = self.query.pending.take() {
            std::mem::forget((call, self.query.origin.clone()));
        }
    }
}
pub struct ObservedImageBinding {
    selection: StorageSelection,
    digest: ImageDigest,
    temporary: PathBuf,
    phase: BindingPhase,
}
#[derive(Clone, Copy)]
enum BindingPhase {
    Temporary,
    Cache,
}
impl ObservedImageBinding {
    /// Fixed cache mkdir at the real selected scratch namespace. This remains
    /// an effect, never a current-binding success: App observes cache=true again.
    pub fn prepare_cache_root(&self) -> reverie_store::chat_images::Result<PathBuf> {
        reverie_store::chat_images::ImageCache::prepare_root(&self.temporary)
    }
    pub fn generation(&self) -> &ImageDigest {
        &self.digest
    }
    pub fn storage_root(&self) -> &Path {
        self.selection.paths().root()
    }
    pub fn temporary_root(&self) -> &Path {
        &self.temporary
    }
}
