//! Actual fixed M actor. The authenticated native record, original hold,
//! current lifecycle/generation and real Office/storage producers stay joined.
mod body;
mod handler;
mod manager;
mod observe;
#[cfg(test)]
mod tests;
use super::*;
use reverie_host::{
    chat_images::{
        ChatImageCache, ImageCacheCaptureFailure, ImageCacheError, ImageMaterialization,
        ImageObservationFailure, ObservedImageBinding,
    },
    office::OfficeImageBinding,
    worker_reports::{WorkerLaunchHold, WorkerReportError, WorkerServiceConnection},
};
use std::{
    fmt,
    sync::atomic::{AtomicBool, AtomicUsize, Ordering},
    time::{Duration, Instant},
};
#[derive(Debug)]
pub enum ChatImagesError {
    Refused(&'static str),
    Codec(reverie_contracts::chat_images::ImageDataError),
    Cache(ImageCacheError),
    Report(WorkerReportError),
    Delivery {
        body: Box<Self>,
        cause: WorkerReportError,
    },
    Cleanup(Vec<Self>),
    Current(Box<Self>),
    Native(reverie_host::chat_images::ImageObserveError),
    Storage(reverie_store::chat_images::ImageStoreError),
    Observation {
        code: &'static str,
        error: Box<ImageObservationFailure>,
    },
}
impl ChatImagesError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Refused(code) => code,
            Self::Codec(error) => error.code(),
            Self::Cache(error) => error.code(),
            Self::Report(_) => "materialization_unavailable",
            Self::Delivery { body, .. } => body.code(),
            Self::Cleanup(_) => "cleanup_unsettled",
            Self::Current(_) => "binding_changed",
            Self::Native(error) => error.code(),
            Self::Storage(error) => error.code(),
            Self::Observation { code, .. } => code,
        }
    }
    fn pending(&self) -> bool {
        match self {
            Self::Observation { error, .. } => error.has_pending_native(),
            Self::Cache(error) => error.is_uncertain(),
            Self::Storage(error) => error.is_uncertain(),
            Self::Delivery { body, .. } => body.pending(),
            Self::Current(error) => error.pending(),
            Self::Cleanup(errors) => errors.iter().any(Self::pending),
            _ => false,
        }
    }
}
impl fmt::Display for ChatImagesError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.write_str(self.code())
    }
}
impl std::error::Error for ChatImagesError {}
type Result<T> = std::result::Result<T, ChatImagesError>;
fn need(value: bool, code: &'static str) -> Result<()> {
    if value {
        Ok(())
    } else {
        Err(ChatImagesError::Refused(code))
    }
}
pub(super) struct ChatImages {
    entries: Mutex<Vec<Arc<ChatImageCache>>>,
    admitted: AtomicUsize,
    stopped: AtomicBool,
}
struct GlobalPermit {
    owner: Arc<ChatImages>,
    released: bool,
}
impl GlobalPermit {
    fn release(&mut self) {
        if !self.released {
            self.owner.admitted.fetch_sub(1, Ordering::AcqRel);
            self.released = true;
        }
    }
}
struct Observation {
    binding: ObservedImageBinding,
    phone: OfficeImageBinding,
}
struct HandlerOwner {
    connection: WorkerServiceConnection,
    hold: Option<WorkerLaunchHold>,
    permit: Option<GlobalPermit>,
    batch: Option<ImageMaterialization>,
    capture: Option<Box<ImageCacheCaptureFailure>>,
}
pub struct ChatImageHandlerClosed {
    primary: Option<ChatImagesError>,
}
impl ChatImageHandlerClosed {
    /// Known body/delivery failure survives successful local finalization.
    /// This is neither global broker nor cache lifetime close acknowledgement.
    pub fn primary_error(&self) -> Option<&ChatImagesError> {
        self.primary.as_ref()
    }
}
pub struct ChatImageHandlerFailure {
    owner: Option<HandlerOwner>,
    primary: Option<ChatImagesError>,
    cleanup: Vec<ChatImagesError>,
}
impl fmt::Debug for ChatImageHandlerFailure {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.debug_struct("ChatImageHandlerFailure")
            .field("primary", &self.primary.as_ref().map(ChatImagesError::code))
            .field(
                "cleanup",
                &self
                    .cleanup
                    .iter()
                    .map(ChatImagesError::code)
                    .collect::<Vec<_>>(),
            )
            .finish_non_exhaustive()
    }
}
impl ChatImageHandlerFailure {
    pub fn primary_error(&self) -> Option<&ChatImagesError> {
        self.primary.as_ref()
    }
    pub fn cleanup_errors(&self) -> &[ChatImagesError] {
        &self.cleanup
    }
}
impl fmt::Display for ChatImageHandlerFailure {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.write_str("CHAT_IMAGES_RETAINED")
    }
}
impl std::error::Error for ChatImageHandlerFailure {}
impl Drop for ChatImageHandlerFailure {
    fn drop(&mut self) {
        if let Some(owner) = self.owner.take() {
            std::mem::forget(owner);
        }
    }
}
