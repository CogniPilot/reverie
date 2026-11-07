//! The actual normal-launch image refresh. The only input source is retained
//! by the real owner loader; no candidate/path setter or file write is exposed.
use super::*;
use crate::reservation_observer::ObservationContext;
use reverie_contracts::worker_config;
use std::path::{Path, PathBuf};
#[cfg(test)]
mod tests;

/// Created only by the real full loader below, never decoded from request data.
pub(crate) struct LoadedLaunchImage {
    source: PathBuf,
    loaded: Arc<ValidatedWorkerSnapshot>,
}
impl LoadedLaunchImage {
    pub(crate) fn source(&self) -> &Path {
        &self.source
    }
}
impl InstallingBroker {
    /// Source handle J loads before taking the lifecycle mutex. The comparison
    /// is against current RAM AFTER acquiring it: an older image-only load may
    /// win publication, while an intervening policy change must refuse it.
    /// Returning a snapshot does not acknowledge disk, start, or global release.
    pub fn refresh_launch_configuration(&self) -> Result<Arc<ValidatedWorkerSnapshot>, GateError> {
        let before = self.configuration()?;
        let Some(path) = before.source_path() else {
            return Ok(before);
        };
        let loaded = crate::worker_validation::load_owner_config(path)?;
        let proof = LoadedLaunchImage {
            source: path.to_owned(),
            loaded: Arc::new(loaded),
        };
        #[cfg(test)]
        {
            let pause = self.installed.image_loaded_pause.lock().unwrap().take();
            if let Some(pause) = pause {
                pause.wait(proof.loaded.clone());
            }
        }
        let lifecycle = self.installed.lifecycle()?;
        match &self.gate {
            Some(gate) => gate.publish_launch_image(proof, &lifecycle),
            None => self.installed.publish_launch_image(proof, &lifecycle, None),
        }
    }
}
impl InstalledWorker {
    pub(crate) fn publish_launch_image(
        &self,
        proof: LoadedLaunchImage,
        lifecycle: &LaptopLifecycle<'_>,
        mut active: Option<&mut ObservationContext>,
    ) -> Result<Arc<ValidatedWorkerSnapshot>, GateError> {
        if !lifecycle.belongs_to(self) {
            return Err(GateError::Refused("WORKER_LAUNCH_IMAGE_LIFECYCLE_CHANGED"));
        }
        let mut current = self
            .current
            .write()
            .map_err(|_| GateError::Refused("WORKER_BROKER_CURRENT_UNAVAILABLE"))?;
        if current.snapshot.source_path() != Some(proof.source())
            || proof.loaded.source_path() != Some(proof.source())
        {
            return Err(GateError::Refused("WORKER_LAUNCH_IMAGE_SOURCE_CHANGED"));
        }
        if !worker_config::image_only_equivalent(
            current.snapshot.configuration(),
            proof.loaded.configuration(),
        ) {
            return Err(GateError::Refused(
                "Restart the host broker after changing worker policy",
            ));
        }
        if active.as_ref().is_some_and(|context| {
            !worker_config::image_only_equivalent(
                context.configuration(),
                proof.loaded.configuration(),
            )
        }) {
            return Err(GateError::Refused("WORKER_LAUNCH_IMAGE_CONTEXT_CHANGED"));
        }
        let next_context = active.as_ref().map(|context| {
            context.with_applied_configuration(proof.loaded.configuration().clone())
        });
        let next = CurrentInstalled::capture(proof.loaded.clone());
        // Gate state, actual active context and current RAM remain locked in
        // that order. All fallible checks end before either publication.
        if let (Some(active), Some(next)) = (active.as_mut(), next_context) {
            **active = next;
        }
        *current = next;
        Ok(proof.loaded)
    }
}
