//! Image-only file publication components. These owners grant no admission,
//! maintenance, service, image-load or worker permission.
mod error;
mod terminal;
#[cfg(test)]
mod tests;
use crate::{gpu_access, native, private_pending::PendingFile};
pub use error::ImageFileError;
use reverie_contracts::{
    reservation_engine::ReservationConfiguration,
    storage_identity::{OrderedMetadata, decode_ordered_metadata},
    worker_config::EffectiveWorkerConfig,
    worker_image_switch::ImagePinTransition,
};
use std::{
    fs::{self, File, OpenOptions},
    io::Read,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
    sync::Arc,
    time::Instant,
};
pub use terminal::{ImageParentGuard, ImageProtectedStores, ImageTerminalSnapshot};
type Result<T> = std::result::Result<T, ImageFileError>;
const MAX: u64 = 1 << 20;
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ImageFileStamp {
    stamp: gpu_access::GpuFileStamp,
    gid: u32,
}
impl ImageFileStamp {
    fn observe(path: &Path) -> Result<Self> {
        let info = fs::symlink_metadata(path).map_err(ImageFileError::io)?;
        Ok(Self::of(&info))
    }
    fn of(info: &fs::Metadata) -> Self {
        Self {
            stamp: gpu_access::GpuFileStamp::of(info),
            gid: info.gid(),
        }
    }
}
pub struct ImagePrivateSnapshot {
    bytes: Vec<u8>,
    metadata: OrderedMetadata,
    stamp: ImageFileStamp,
}
impl ImagePrivateSnapshot {
    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }
    pub fn metadata(&self) -> &OrderedMetadata {
        &self.metadata
    }
    pub fn stamp(&self) -> &ImageFileStamp {
        &self.stamp
    }
}
struct Owner {
    source: PathBuf,
    config: ReservationConfiguration,
    brand: Arc<()>,
    pending_attempted: bool,
    configuration_attempted: bool,
    released: bool,
    failure: Option<ImageFileError>,
    intent: Option<Arc<ImagePinTransition>>,
    partial_pending: Option<ImagePendingFile>,
    end: Option<Instant>,
}
/// Fixed loader-selected source, not a request path or a maintenance permit.
#[must_use = "retain the same file owner after any publication attempt"]
pub struct ImageControlFiles {
    owner: Option<Owner>,
}
#[must_use = "only the original file owner may release this pending component"]
pub struct ImagePendingFile {
    file: Option<PendingFile>,
    brand: Arc<()>,
    intent: Arc<ImagePinTransition>,
    end: Instant,
}
/// A real successful image CAS/readback; it grants no App/domain completion.
pub struct ImagePublication {
    brand: Arc<()>,
    stamp: ImageFileStamp,
}
impl ImageControlFiles {
    pub fn capture(source: &Path, config: &EffectiveWorkerConfig) -> Self {
        Self {
            owner: Some(Owner {
                source: source.to_owned(),
                config: ReservationConfiguration::capture(config.clone()),
                brand: Arc::new(()),
                pending_attempted: false,
                configuration_attempted: false,
                released: false,
                failure: None,
                intent: None,
                partial_pending: None,
                end: None,
            }),
        }
    }
    fn owner(&self) -> &Owner {
        self.owner.as_ref().expect("same original file owner")
    }
    fn live(&self) -> Result<()> {
        match &self.owner().failure {
            Some(error) => Err(error.clone()),
            None => Ok(()),
        }
    }
    fn finish<T>(&mut self, result: Result<T>) -> Result<T> {
        if let Err(error) = &result {
            self.owner
                .as_mut()
                .expect("same owner")
                .failure
                .get_or_insert_with(|| error.clone());
        }
        result
    }
    pub fn read_configuration(&mut self) -> Result<ImagePrivateSnapshot> {
        self.live()?;
        let result = self.read(&self.owner().source);
        self.finish(result)
    }
    fn read(&self, path: &Path) -> Result<ImagePrivateSnapshot> {
        let expected = ImageFileStamp::observe(path)?;
        let uid = self
            .owner()
            .config
            .uid()
            .map_err(ImageFileError::configuration)?;
        require(expected.stamp.private(uid), "WORKER_IMAGE_PRIVATE_FILE")?;
        let mut file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
            .open(path)
            .map_err(ImageFileError::io)?;
        let body = self.read_opened(&mut file, path, &expected);
        let bytes = error::finalized(body, native::close(file).map_err(ImageFileError::native))?;
        let metadata = decode_ordered_metadata(&bytes).map_err(ImageFileError::data)?;
        Ok(ImagePrivateSnapshot {
            bytes,
            metadata,
            stamp: expected,
        })
    }
    fn read_opened(
        &self,
        file: &mut File,
        path: &Path,
        expected: &ImageFileStamp,
    ) -> Result<Vec<u8>> {
        let info = file.metadata().map_err(ImageFileError::io)?;
        require(
            ImageFileStamp::of(&info) == *expected && info.len() <= MAX,
            "WORKER_IMAGE_SOURCE_CHANGED",
        )?;
        let mut raw = Vec::new();
        (&mut *file)
            .take(MAX + 1)
            .read_to_end(&mut raw)
            .map_err(ImageFileError::io)?;
        require(
            raw.len() as u64 == info.len()
                && raw.len() as u64 <= MAX
                && ImageFileStamp::of(&file.metadata().map_err(ImageFileError::io)?) == *expected
                && ImageFileStamp::observe(path)? == *expected,
            "WORKER_IMAGE_SOURCE_CHANGED",
        )?;
        Ok(raw)
    }
    pub fn publish_pending(
        &mut self,
        intent: Arc<ImagePinTransition>,
        end: Instant,
    ) -> Result<ImagePendingFile> {
        self.live()?;
        let result = self.begin_pending(intent, end);
        self.finish(result)
    }
    fn begin_pending(
        &mut self,
        intent: Arc<ImagePinTransition>,
        end: Instant,
    ) -> Result<ImagePendingFile> {
        require(
            !self.owner().pending_attempted && Instant::now() < end,
            "WORKER_IMAGE_ATTEMPT_USED",
        )?;
        require(
            reverie_contracts::worker_config::equivalent(
                self.owner().config.configuration(),
                intent.before(),
            ),
            "WORKER_IMAGE_SOURCE_CHANGED",
        )?;
        let before = self.read(&self.owner().source)?;
        require(
            before.bytes() == intent.before_bytes(),
            "WORKER_IMAGE_SOURCE_CHANGED",
        )?;
        let path = self.pending_path()?;
        let parent = gpu_access::open_control_parent(
            path.parent()
                .ok_or_else(|| ImageFileError::refused("WORKER_IMAGE_PARENT"))?,
        )
        .map_err(ImageFileError::shared)?;
        // Store the attempt before the first exclusive creation. A refusal can
        // still leave durable evidence and never permits replacement/retry.
        let owner = self.owner.as_mut().expect("same owner");
        owner.pending_attempted = true;
        owner.intent = Some(intent.clone());
        owner.end = Some(end);
        let file =
            PendingFile::create(parent, path, intent.bytes(), native::policy_effective_uid())
                .map_err(ImageFileError::pending)?;
        self.owner.as_mut().expect("same owner").partial_pending = Some(ImagePendingFile {
            file: Some(file),
            brand: self.owner().brand.clone(),
            intent,
            end,
        });
        self.assert_pending(
            self.owner()
                .partial_pending
                .as_ref()
                .expect("stored original pending"),
        )?;
        Ok(self
            .owner
            .as_mut()
            .expect("same owner")
            .partial_pending
            .take()
            .expect("checked pending"))
    }
    fn pending_path(&self) -> Result<PathBuf> {
        let paths = self
            .owner()
            .config
            .control_paths()
            .map_err(ImageFileError::configuration)?;
        native::python_path(&paths.pending().codepoints()).map_err(ImageFileError::io)
    }
    fn assert_pending(&self, pending: &ImagePendingFile) -> Result<()> {
        require(
            Arc::ptr_eq(&self.owner().brand, &pending.brand),
            "WORKER_IMAGE_FOREIGN_OWNER",
        )?;
        let file = pending
            .file
            .as_ref()
            .ok_or_else(|| ImageFileError::refused("WORKER_IMAGE_PENDING_RELEASED"))?;
        require(
            file.unreleased() && file.path() == self.pending_path()?,
            "WORKER_IMAGE_PENDING_CHANGED",
        )?;
        let read = self.read(file.path())?;
        require(
            read.stamp.stamp == gpu_access::GpuFileStamp::from_native(file.stamp().clone())
                && pending.intent.matches_metadata(&read.metadata),
            "WORKER_IMAGE_PENDING_CHANGED",
        )
    }
    pub fn assert_pending_current(&mut self, pending: &ImagePendingFile) -> Result<()> {
        self.live()?;
        let result = self.assert_pending(pending);
        self.finish(result)
    }
    pub fn publish_configuration(
        &mut self,
        intent: &ImagePinTransition,
        expected: &ImageFileStamp,
        pending: &ImagePendingFile,
    ) -> Result<ImagePublication> {
        self.live()?;
        let result = self.publish_image(intent, expected, pending);
        self.finish(result)
    }
    fn publish_image(
        &mut self,
        intent: &ImagePinTransition,
        expected: &ImageFileStamp,
        pending: &ImagePendingFile,
    ) -> Result<ImagePublication> {
        require(
            self.owner().pending_attempted && !self.owner().configuration_attempted,
            "WORKER_IMAGE_PUBLICATION_PHASE",
        )?;
        require(
            self.owner()
                .intent
                .as_deref()
                .is_some_and(|own| std::ptr::eq(own, intent)),
            "WORKER_IMAGE_FOREIGN_INTENT",
        )?;
        self.assert_pending(pending)?;
        let before = self.read(&self.owner().source)?;
        require(
            before.stamp == *expected && before.bytes() == intent.before_bytes(),
            "WORKER_IMAGE_SOURCE_CAS_CHANGED",
        )?;
        let end = self.owner().end.expect("actual pending deadline");
        require(Instant::now() < end, "WORKER_IMAGE_DEADLINE")?;
        self.owner
            .as_mut()
            .expect("same owner")
            .configuration_attempted = true;
        let stamp = gpu_access::replace_image_configuration(
            &self.owner().source,
            intent.configuration_bytes(),
            &expected.stamp,
            expected.gid,
            end,
            pending.file.as_ref().expect("checked original pending"),
        )
        .map_err(ImageFileError::shared)?;
        require(Instant::now() < end, "WORKER_IMAGE_DEADLINE").map_err(ImageFileError::unknown)?;
        Ok(ImagePublication {
            brand: self.owner().brand.clone(),
            stamp: ImageFileStamp {
                stamp,
                gid: expected.gid,
            },
        })
    }
}
fn require(value: bool, code: &'static str) -> Result<()> {
    if value {
        Ok(())
    } else {
        Err(ImageFileError::refused(code))
    }
}
impl Drop for ImageControlFiles {
    fn drop(&mut self) {
        if self.owner.as_ref().is_some_and(|o| {
            !o.released
                && (o.pending_attempted
                    || o.failure
                        .as_ref()
                        .is_some_and(ImageFileError::has_unconfirmed_close))
        }) {
            std::mem::forget(self.owner.take());
        }
    }
}
impl Drop for ImagePendingFile {
    fn drop(&mut self) {
        if self.file.as_ref().is_some_and(|file| !file.confirmed()) {
            std::mem::forget((self.file.take(), self.brand.clone(), self.intent.clone()));
        }
    }
}
