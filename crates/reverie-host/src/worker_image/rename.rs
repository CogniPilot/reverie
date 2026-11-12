//! Fixed borrowed joins to the SAME live owners; no callback or grant factory.
use super::*;
use crate::worker_service::ImageServiceMaintenance;
pub(crate) struct ImageRenameFence<'a> {
    source: &'a Path,
    locks: &'a mut ImageMaintenanceLocks,
    service: &'a ImageServiceMaintenance,
}
impl<'a> ImageRenameFence<'a> {
    pub(crate) fn new(
        source: &'a Path,
        locks: &'a mut ImageMaintenanceLocks,
        service: &'a ImageServiceMaintenance,
    ) -> Self {
        Self {
            source,
            locks,
            service,
        }
    }
    pub(crate) fn assert_current(&mut self) -> Result<()> {
        require(
            self.locks.source() == self.source && self.service.source() == self.source,
            "WORKER_IMAGE_MAINTAINED_SOURCE_CHANGED",
        )?;
        self.locks.assert_held_current()?;
        self.service
            .assert_publication_current(self.source)
            .map_err(ImageFileError::service)
    }
}
impl ImageControlFiles {
    /// Actual App publication must use these SAME held original outer owners.
    pub fn publish_maintained_configuration(
        &mut self,
        intent: &ImagePinTransition,
        expected: &ImageFileStamp,
        pending: &ImagePendingFile,
        locks: &mut ImageMaintenanceLocks,
        service: &ImageServiceMaintenance,
    ) -> Result<ImagePublication> {
        self.live()?;
        let source = self.owner().source.clone();
        let mut fence = ImageRenameFence::new(&source, locks, service);
        let result = fence
            .assert_current()
            .and_then(|()| self.publish_image(intent, expected, pending, Some(&mut fence)));
        self.finish(result)
    }
}
