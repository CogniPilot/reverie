//! Readonly preview freezes actual source/native census; only the eventual
//! service+maintenance+admission owner may attempt publication.
use super::*;
use reverie_contracts::{
    resource_actor::ArtifactReference, worker_config, worker_image_switch::WorkerImageId,
};
use reverie_core::operations::JournalDigest;
use reverie_host::worker_image::{ImageControlFiles, ImageFileStamp};
use sha2::{Digest, Sha256};
pub(crate) struct ImageSwitchPreview {
    pub(super) before: Arc<ValidatedWorkerSnapshot>,
    pub(super) raw: Vec<u8>,
    pub(super) stamp: ImageFileStamp,
    pub(super) rows: Arc<ObservedInventory>,
    pub(super) image: WorkerImageId,
    digest: JournalDigest,
}
impl ImageSwitchPreview {
    pub(crate) fn digest(&self) -> &JournalDigest {
        &self.digest
    }
}
impl ReservationGate {
    pub(crate) fn assert_image_preview(
        &self,
        preview: &ImageSwitchPreview,
        files: &mut ImageControlFiles,
        end: Instant,
    ) -> Result<()> {
        let admission = self.inner.admit(AdmissionBounds {
            operation: Some(end),
            entry: Some(end),
        })?;
        let result = self
            .inner
            .assert_image_preview_held(preview, files)
            .map(|_| ());
        admission.conclude(result)
    }
}
impl Inner {
    pub(super) fn assert_image_preview_held(
        self: &Arc<Self>,
        preview: &ImageSwitchPreview,
        files: &mut ImageControlFiles,
    ) -> Result<Arc<ObservedInventory>> {
        let current = self.installed.snapshot()?;
        need(
            Arc::ptr_eq(&current, &preview.before)
                && current.envelope().base().image() != preview.image.as_str(),
            "WORKER_IMAGE_PREVIEW_CHANGED",
        )?;
        let rows = Arc::new(self.image_idle()?);
        need(
            rows.equivalent(&preview.rows),
            "WORKER_IMAGE_NATIVE_CHANGED",
        )?;
        let source = files.read_configuration()?;
        need(
            source.stamp() == &preview.stamp && source.bytes() == preview.raw,
            "WORKER_IMAGE_PREVIEW_CHANGED",
        )?;
        Ok(rows)
    }
}
impl ReservationGate {
    pub(crate) fn preview_offline_image(
        &self,
        files: &mut ImageControlFiles,
        before: &Arc<ValidatedWorkerSnapshot>,
        image: &WorkerImageId,
        base: &ArtifactReference,
        annex: &ArtifactReference,
        end: Instant,
    ) -> Result<ImageSwitchPreview> {
        let admission = self.inner.admit(AdmissionBounds {
            operation: Some(end),
            entry: Some(end),
        })?;
        let body = (|| {
            need(
                Arc::ptr_eq(before, &self.inner.installed.snapshot()?),
                "WORKER_IMAGE_CONFIGURATION_CHANGED",
            )?;
            need(
                before.envelope().base().image() != image.as_str(),
                "WORKER_IMAGE_ALREADY_SELECTED",
            )?;
            let rows = Arc::new(self.inner.image_idle()?);
            let source = files.read_configuration()?;
            let config = worker_config::decode(source.bytes())?;
            need(
                worker_config::equivalent(&config, before.configuration()),
                "WORKER_IMAGE_CONFIGURATION_CHANGED",
            )?;
            let mut census = rows
                .rows()
                .map(|row| {
                    Ok((
                        row.data().id().as_str().to_owned(),
                        row.data().snapshot_digest()?.to_hex(),
                    ))
                })
                .collect::<Result<Vec<_>>>()?;
            census.sort();
            let selected = serde_json::json!({"version":1,"purpose":"worker-image-switch-preview-v1","sourceConfigSHA256":format!("{:x}",Sha256::digest(source.bytes())),"oldImage":before.envelope().base().image(),"newImage":image.as_str(),"baseProvenanceSHA256":base.sha256.as_str(),"nativeChildAnnexSHA256":annex.sha256.as_str(),"census":census});
            let digest = JournalDigest::parse(&format!(
                "{:x}",
                Sha256::digest(serde_json::to_vec(&selected).expect("fixed scalar preview DATA"))
            ))
            .expect("SHA256");
            self.inner
                .image_idle()
                .and_then(|after| need(rows.equivalent(&after), "WORKER_IMAGE_NATIVE_CHANGED"))?;
            Ok(ImageSwitchPreview {
                before: before.clone(),
                raw: source.bytes().to_vec(),
                stamp: source.stamp().clone(),
                rows,
                image: image.clone(),
                digest,
            })
        })();
        admission.conclude(body)
    }
}
